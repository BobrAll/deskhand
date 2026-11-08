// Native helper for Smart Cursor.
// Provides the macOS pieces that Electron cannot do reliably from JS:
//   * front        - frontmost application info + focused window id/bounds/title
//   * cursor       - current mouse location in screen coordinates
//   * copy / paste - synthesize Cmd+C / Cmd+V
//   * activate     - bring an application back to the front
//   * permissions  - accessibility + screen recording state (optionally prompting)
//   * voice        - long-lived push-to-talk listener (CGEventTap, JSON lines)
//   * gesture      - long-lived trackpad listener (tap / hold, JSON lines)
//   * ping         - liveness probe
// One-shot commands write a single JSON object on stdout; `voice` and `gesture`
// stream one JSON object per line until they are killed.

#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <math.h>
#import <dlfcn.h>
#import <fcntl.h>
#import <unistd.h>
#import <signal.h>

#import "gesture.h"

static void emit(NSDictionary *payload) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&error];
  if (error || !data) {
    fputs("{\"ok\":false,\"error\":\"json\"}\n", stdout);
    return;
  }
  fwrite([data bytes], 1, [data length], stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

// Match the focused AX window to WindowServer by geometry and, when available,
// title. An ambiguous match must not attach an unrelated CG window ID.
static NSDictionary *focusedWindowInfo(pid_t pid) {
  if (!AXIsProcessTrusted()) return nil;
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  AXUIElementSetMessagingTimeout(app, 0.05f);
  CFTypeRef window = NULL;
  AXError status = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, &window);
  CFRelease(app);
  if (!window) return status == kAXErrorNoValue ? nil : @{};
  AXUIElementSetMessagingTimeout((AXUIElementRef)window, 0.05f);
  CFTypeRef pos = NULL, size = NULL, title = NULL;
  AXUIElementCopyAttributeValue((AXUIElementRef)window, kAXPositionAttribute, &pos);
  AXUIElementCopyAttributeValue((AXUIElementRef)window, kAXSizeAttribute, &size);
  AXUIElementCopyAttributeValue((AXUIElementRef)window, kAXTitleAttribute, &title);
  CGPoint origin;
  CGSize dimensions;
  BOOL geometry = pos && size && CFGetTypeID(pos) == AXValueGetTypeID() &&
      CFGetTypeID(size) == AXValueGetTypeID() &&
      AXValueGetValue((AXValueRef)pos, kAXValueCGPointType, &origin) &&
      AXValueGetValue((AXValueRef)size, kAXValueCGSizeType, &dimensions);
  NSString *name = title && CFGetTypeID(title) == CFStringGetTypeID() ? [(__bridge NSString *)title copy] : nil;
  if (pos) CFRelease(pos);
  if (size) CFRelease(size);
  if (title) CFRelease(title);
  CFRelease(window);

  NSMutableDictionary *result = [NSMutableDictionary dictionary];
  if (name.length) result[(id)kCGWindowName] = name;
  if (!geometry) return result;
  result[(id)kCGWindowBounds] = @{@"X": @(origin.x), @"Y": @(origin.y),
                                  @"Width": @(dimensions.width), @"Height": @(dimensions.height)};
  NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
  NSNumber *only = nil, *named = nil;
  NSUInteger matches = 0, namedMatches = 0;
  for (NSDictionary *win in windows) {
    if ([win[(id)kCGWindowOwnerPID] intValue] != pid) continue;
    CGRect rect;
    NSDictionary *bounds = win[(id)kCGWindowBounds];
    if (!bounds || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bounds, &rect)) continue;
    if (fabs(rect.origin.x - origin.x) > 1 || fabs(rect.origin.y - origin.y) > 1 ||
        fabs(rect.size.width - dimensions.width) > 1 || fabs(rect.size.height - dimensions.height) > 1) continue;
    only = win[(id)kCGWindowNumber];
    matches++;
    NSString *cgName = win[(id)kCGWindowName];
    if (name.length && [cgName isEqualToString:name]) {
      named = only;
      namedMatches++;
    }
  }
  NSNumber *number = matches == 1 ? only : namedMatches == 1 ? named : nil;
  if (number) result[(id)kCGWindowNumber] = number;
  return result;
}

static int commandFront(pid_t target) {
  NSRunningApplication *front = target > 0 ? [NSRunningApplication runningApplicationWithProcessIdentifier:target]
                                           : [[NSWorkspace sharedWorkspace] frontmostApplication];
  if (!front) {
    emit(@{@"ok" : @NO, @"error" : @"no-frontmost-application"});
    return 0;
  }
  pid_t pid = [front processIdentifier];
  NSDictionary *win = focusedWindowInfo(pid);
  NSMutableDictionary *result = [NSMutableDictionary dictionary];
  result[@"ok"] = @YES;
  result[@"bundleId"] = [front bundleIdentifier] ?: @"";
  result[@"name"] = [front localizedName] ?: @"";
  result[@"pid"] = @(pid);
  result[@"accessibility"] = @(AXIsProcessTrusted());
  if (win) {
    result[@"windowId"] = win[(id)kCGWindowNumber];
    result[@"bounds"] = win[(id)kCGWindowBounds];
    NSString *windowName = win[(id)kCGWindowName];
    if ([windowName isKindOfClass:[NSString class]] && [windowName length] > 0) {
      result[@"title"] = windowName;
    }
  }
  emit(result);
  return 0;
}

static void postKey(CGKeyCode code) {
  CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);
  CGEventRef down = CGEventCreateKeyboardEvent(source, code, true);
  CGEventRef up = CGEventCreateKeyboardEvent(source, code, false);
  CGEventSetFlags(down, kCGEventFlagMaskCommand);
  CGEventSetFlags(up, kCGEventFlagMaskCommand);
  CGEventPost(kCGHIDEventTap, down);
  usleep(12000);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(down);
  CFRelease(up);
  if (source) CFRelease(source);
}

static int commandKey(const char *which) {
  BOOL trusted = AXIsProcessTrusted();
  if (!trusted) {
    emit(@{@"ok" : @NO, @"error" : @"accessibility-denied"});
    return 0;
  }
  if (strcmp(which, "copy") == 0) {
    postKey((CGKeyCode)8);  // kVK_ANSI_C
  } else {
    postKey((CGKeyCode)9);  // kVK_ANSI_V
  }
  emit(@{@"ok" : @YES});
  return 0;
}

// MARK: - Agent: mouse and keyboard

// Everything below posts events into whatever application is frontmost. macOS
// allows that only for a process the user trusted with Accessibility, and the
// check is repeated here rather than trusted from the caller: a helper that
// silently does nothing is worse than one that says why.
//
// Two details make synthetic input behave like a person instead of like a
// macro: the cursor is moved *before* the button goes down (an app that
// highlights on hover needs the hover to have happened), and every event is
// given a moment to be delivered before the next one is posted. A plan that
// fires four events in the same microsecond is dropped or reordered by the
// window server.

static volatile sig_atomic_t agentCancelled = 0;
static pid_t agentExpectedPid = 0;
static long agentExpectedWindow = 0;
static CGRect agentExpectedBounds;
static BOOL agentHasExpectedBounds = NO;

static void cancelAgentInput(int signalNumber) {
  (void)signalNumber;
  agentCancelled = 1;
}

static BOOL agentCanPost(void) {
  if (agentCancelled) return NO;
  return !agentExpectedPid ||
      [[NSWorkspace sharedWorkspace] frontmostApplication].processIdentifier == agentExpectedPid;
}

static BOOL agentTargetMatches(void) {
  if (!agentCanPost()) return NO;
  if (!agentExpectedPid) return YES;
  NSDictionary *focused = focusedWindowInfo(agentExpectedPid);
  // Only compare the window number when one was actually named.
  //
  // This used to read `: focused != nil`, which rejected the action whenever the
  // application *had* a focused window — the exact opposite of a match. The
  // caller passes 0 when it could not determine the number, and that is the
  // normal case for any app whose window the CGWindowList cannot single out
  // (Chrome among them, where the on-screen list holds several windows with the
  // same bounds). So every addressed click and keystroke into such an app was
  // refused as `target-changed` before a single event was posted.
  if (agentExpectedWindow > 0) {
    NSNumber *actual = focused[(id)kCGWindowNumber];
    if (!actual || actual.longValue != agentExpectedWindow) return NO;
  }
  if (agentHasExpectedBounds) {
    NSDictionary *bounds = focused[(id)kCGWindowBounds];
    CGRect rect;
    if (!bounds || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bounds, &rect) ||
        !CGRectEqualToRect(rect, agentExpectedBounds)) return NO;
  }
  return agentCanPost();
}

static void agentSleep(double ms) {
  if (ms <= 0) return;
  usleep((useconds_t)(ms * 1000.0));
}

/**
 * Every event this helper posts is stamped with this value in
 * `kCGEventSourceUserData`.
 *
 * Without it the abort watcher cannot tell the assistant's own click from the
 * user grabbing the mouse: both arrive at the tap as an ordinary mouse move, and
 * a plan would cancel itself on its first step. The stamp is what makes "движение
 * мыши — вернуть контроль" mean *the person*, not *the pointer*.
 */
static const int64_t kAgentEventTag = 0x53434752;  // 'SCGR'

static void agentTag(CGEventRef event) {
  if (!event) return;
  CGEventSetIntegerValueField(event, kCGEventSourceUserData, kAgentEventTag);
}

/**
 * Moves the cursor itself.
 *
 * `CGEventPost` with `kCGEventMouseMoved` does not relocate the hardware cursor —
 * apps see a move, but the pointer stays where it was, and the next click then
 * lands on the old spot. `CGWarpMouseCursorPosition` is the call that actually
 * moves it; the posted event afterwards is what makes hover states and
 * cursor-following UI react. Re-associating right after the warp is required
 * because warping otherwise leaves the mouse decoupled for a fraction of a
 * second, and the first click after it would be swallowed.
 *
 * Coordinates are top-left global display points, the same space Electron and
 * `commandCursor` report — *not* AppKit's bottom-left space. Nothing is flipped
 * here on purpose: `CGEventCreateMouseEvent` and `CGWarpMouseCursorPosition` both
 * take the display origin at the top-left, so flipping would mirror every click
 * about the middle of the screen.
 */
static void agentMoveTo(CGFloat x, CGFloat y) {
  CGWarpMouseCursorPosition(CGPointMake(x, y));
  CGAssociateMouseAndMouseCursorPosition(true);

  CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, CGPointMake(x, y),
                                            kCGMouseButtonLeft);
  if (move) {
    CGEventSetFlags(move, 0);
    agentTag(move);
    CGEventPost(kCGHIDEventTap, move);
    CFRelease(move);
  }
}

static CGEventType agentEventTypeFor(CGMouseButton button, BOOL down) {
  if (button == kCGMouseButtonRight) return down ? kCGEventRightMouseDown : kCGEventRightMouseUp;
  if (button == kCGMouseButtonCenter) return down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp;
  return down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
}

static NSDictionary *agentClick(CGFloat x, CGFloat y, CGMouseButton button, int count) {
  // Give the app a frame to process the pointer move before pressing.
  agentMoveTo(x, y);
  CFTimeInterval moved = [[NSProcessInfo processInfo] systemUptime];
  double pressMs = 0;
  agentSleep(32);
  CGPoint point = CGPointMake(x, y);
  for (int index = 0; index < count; index++) {
    if (!agentTargetMatches()) return @{@"ok": @NO, @"error": @"interrupted"};
    CGEventRef down = CGEventCreateMouseEvent(NULL, agentEventTypeFor(button, YES), point, button);
    CGEventRef up = CGEventCreateMouseEvent(NULL, agentEventTypeFor(button, NO), point, button);
    if (!down || !up) {
      if (down) CFRelease(down);
      if (up) CFRelease(up);
      return @{@"ok": @NO, @"error": @"event-allocation"};
    }
    {
      CGEventSetIntegerValueField(down, kCGMouseEventClickState, index + 1);
      CGEventSetFlags(down, 0);
      agentTag(down);
      if (index == 0) pressMs = ([[NSProcessInfo processInfo] systemUptime] - moved) * 1000;
      CGEventPost(kCGHIDEventTap, down);
      CFRelease(down);
    }
    agentSleep(20);
    {
      CGEventSetIntegerValueField(up, kCGMouseEventClickState, index + 1);
      CGEventSetFlags(up, 0);
      agentTag(up);
      CGEventPost(kCGHIDEventTap, up);
      CFRelease(up);
    }
    // Only wait if another press follows this release.
    if (index + 1 < count) agentSleep(60);
  }
  double releaseMs = ([[NSProcessInfo processInfo] systemUptime] - moved) * 1000;
  return @{@"ok": @YES, @"pressMs": @(pressMs), @"releaseMs": @(releaseMs)};
}

static BOOL agentDrag(CGFloat x1, CGFloat y1, CGFloat x2, CGFloat y2) {
  // Same top-left space as everything else in this section.
  CGPoint from = CGPointMake(x1, y1);
  CGPoint to = CGPointMake(x2, y2);

  agentMoveTo(x1, y1);
  agentSleep(90);
  if (!agentTargetMatches()) return NO;
  CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, from, kCGMouseButtonLeft);
  CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, from, kCGMouseButtonLeft);
  if (!down || !up) {
    if (down) CFRelease(down);
    if (up) CFRelease(up);
    return NO;
  }
  {
    CGEventSetFlags(down, 0);
    agentTag(down);
    CGEventPost(kCGHIDEventTap, down);
    CFRelease(down);
  }
  // Intermediate moves: a single jump to the destination is treated as a
  // teleport by drag-and-drop targets that track the path (Finder, browsers).
  const int steps = 12;
  CGPoint last = from;
  int index = 1;
  for (; index <= steps && agentCanPost(); index++) {
    double t = (double)index / (double)steps;
    CGPoint point = CGPointMake(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    last = point;
    CGEventRef drag = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDragged, point,
                                              kCGMouseButtonLeft);
    if (drag) {
      CGEventSetFlags(drag, 0);
      agentTag(drag);
      CGEventPost(kCGHIDEventTap, drag);
      CFRelease(drag);
    }
    agentSleep(18);
  }
  {
    CGEventSetLocation(up, last);
    CGEventSetFlags(up, 0);
    agentTag(up);
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(up);
  }
  return index > steps && agentCanPost();
}

static void agentScroll(double dx, double dy) {
  CGEventRef event = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2, (int32_t)dy,
                                                   (int32_t)dx);
  if (event) {
    agentTag(event);
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
  }
}

/**
 * Types a string into the focused field.
 *
 * The text travels as a Unicode payload on a synthetic key event rather than as
 * a sequence of key codes: key codes are layout-dependent, so "привет" typed
 * through them would come out as garbage on a US keyboard. One event per
 * character keeps the pace readable and lets an app that debounces input still
 * see each keystroke.
 */
static BOOL agentType(NSString *text) {
  NSUInteger length = [text length];
  CFTimeInterval nextTargetCheck = 0;
  for (NSUInteger index = 0; index < length;) {
    if (!agentCanPost()) return NO;
    CFTimeInterval now = NSProcessInfo.processInfo.systemUptime;
    if (now >= nextTargetCheck) {
      if (!agentTargetMatches()) return NO;
      nextTargetCheck = NSProcessInfo.processInfo.systemUptime + 0.075;
    }
    NSRange range = [text rangeOfComposedCharacterSequenceAtIndex:index];
    unichar buffer[20];
    // A pathological grapheme can exceed the CGEvent payload. Split only at
    // Unicode scalar boundaries so surrogate pairs always travel together.
    NSUInteger count = MIN(NSMaxRange(range) - index, 20);
    if (CFStringIsSurrogateHighCharacter([text characterAtIndex:index + count - 1])) count--;
    [text getCharacters:buffer range:NSMakeRange(index, count)];
    index += count;
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)0, true);
    CGEventRef up = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)0, false);
    if (!down || !up) {
      if (down) CFRelease(down);
      if (up) CFRelease(up);
      return NO;
    }
    // Modifiers are cleared explicitly. A freshly created key event inherits the
    // *current* modifier state, so a typed "a" while Command happened to be down
    // would arrive as Cmd+A — select-all instead of a letter. Typing must never
    // be at the mercy of a key the user happens to be resting a finger on.
    if (down) {
      CGEventSetFlags(down, 0);
      CGEventKeyboardSetUnicodeString(down, count, buffer);
      agentTag(down);
      CGEventPost(kCGHIDEventTap, down);
      CFRelease(down);
    }
    if (up) {
      CGEventSetFlags(up, 0);
      CGEventKeyboardSetUnicodeString(up, count, buffer);
      agentTag(up);
      CGEventPost(kCGHIDEventTap, up);
      CFRelease(up);
    }
    agentSleep(8);
  }
  return YES;
}

/** Presses one key with a modifier mask; used for shortcuts and Return/Tab. */
static BOOL agentKey(int64_t keyCode, CGEventFlags flags) {
  CGEventRef down = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)keyCode, true);
  CGEventRef up = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)keyCode, false);
  if (!down || !up) {
    if (down) CFRelease(down);
    if (up) CFRelease(up);
    return NO;
  }
  {
    // A shortcut is the one place where the flags are the point: ⌘S is not "s
    // with modifiers lying around", it is the combination itself.
    CGEventSetFlags(down, flags);
    agentTag(down);
    CGEventPost(kCGHIDEventTap, down);
    CFRelease(down);
  }
  agentSleep(30);
  {
    CGEventSetFlags(up, flags);
    agentTag(up);
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(up);
  }
  return YES;
}

static int agentRequireAccessibility(void) {
  if (AXIsProcessTrusted()) return 0;
  emit(@{@"ok" : @NO, @"error" : @"accessibility-denied"});
  return 1;
}

// MARK: - Agent: taking control back

// The whole point of an agent mode that moves the user's cursor is that the
// user can always stop it. Escape and a physical mouse movement are the two
// signals macOS gives us for free, and both are watched by a tap that is alive
// only while a plan runs — the tap prints one JSON line per event and exits
// when the parent closes its pipe or sends SIGTERM.

typedef struct {
  CGPoint origin;
  BOOL moved;
  BOOL interaction;
  CFMachPortRef tap;
} WatchState;

/** True for an event this helper posted itself (see `agentTag`). */
static BOOL isAgentEvent(CGEventRef event) {
  return CGEventGetIntegerValueField(event, kCGEventSourceUserData) == kAgentEventTag;
}

static CGEventRef watchCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event,
                                void *info) {
  WatchState *state = (WatchState *)info;
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (state->tap) CGEventTapEnable(state->tap, true);
    return event;
  }
  // The assistant's own clicks and moves pass through here too. They are tagged
  // at the source, so "движение мыши" can mean the person without the plan
  // cancelling itself on its own first step.
  if (isAgentEvent(event)) return event;

  if (state->interaction) {
    emit(@{@"event" : @"interaction"});
    return event;
  }

  if (type == kCGEventKeyDown) {
    int64_t code = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    if (code == (int64_t)kVK_Escape) emit(@{@"event" : @"escape"});
    return event;
  }
  if (type == kCGEventMouseMoved || type == kCGEventLeftMouseDragged ||
      type == kCGEventRightMouseDragged) {
    if (type == kCGEventMouseMoved && !state->moved) {
      // A person's hand is never perfectly still, so a few pixels of drift are
      // not "taking control back" — the threshold is the difference between a
      // nudge and a grab.
      CGPoint now = CGEventGetLocation(event);
      CGFloat dx = now.x - state->origin.x;
      CGFloat dy = now.y - state->origin.y;
      if (sqrt(dx * dx + dy * dy) <= 12.0) return event;
    }
    state->moved = YES;
    CGPoint now = CGEventGetLocation(event);
    emit(@{@"event" : @"mousemove", @"x" : @(now.x), @"y" : @(now.y)});
    return event;
  }
  return event;
}

static int commandWatch(BOOL watchMouse, BOOL interaction) {
  if (agentRequireAccessibility()) return 0;

  WatchState state = {.origin = CGEventGetLocation(CGEventCreate(NULL)), .moved = NO, .interaction = interaction, .tap = NULL};
  CGEventMask mask = CGEventMaskBit(kCGEventKeyDown);
  if (interaction) {
    mask |= CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventRightMouseDown) |
            CGEventMaskBit(kCGEventOtherMouseDown) | CGEventMaskBit(kCGEventScrollWheel);
  }
  if (watchMouse) {
    mask |= CGEventMaskBit(kCGEventMouseMoved) | CGEventMaskBit(kCGEventLeftMouseDragged) |
            CGEventMaskBit(kCGEventRightMouseDragged);
  }
  CFMachPortRef tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap,
                                       kCGEventTapOptionListenOnly, mask, watchCallback, &state);
  if (!tap) {
    emit(@{@"ok" : @NO, @"error" : @"tap-create-failed"});
    return 0;
  }
  state.tap = tap;
  CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
  CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
  CGEventTapEnable(tap, true);
  emit(@{@"ok" : @YES, @"event" : @"ready"});
  CFRunLoopRun();

  CFRelease(source);
  CFRelease(tap);
  return 0;
}

static int commandOpenBrowser(void) {
  NSWorkspace *workspace = [NSWorkspace sharedWorkspace];
  // Resolve the default HTTPS handler without loading a page.
  NSURL *url = [workspace URLForApplicationToOpenURL:[NSURL URLWithString:@"https://example.invalid/"]];
  if (!url) {
    emit(@{@"ok": @NO, @"error": @"browser-not-found"});
    return 0;
  }
  if (agentCancelled) { emit(@{@"ok": @NO, @"error": @"interrupted"}); return 0; }
  NSRunningApplication *browser = [workspace launchApplicationAtURL:url
    options:NSWorkspaceLaunchDefault configuration:@{} error:NULL];
  NSString *bundleId = [browser bundleIdentifier];
  if (!bundleId) {
    emit(@{@"ok": @NO, @"error": @"browser-launch-failed"});
    return 0;
  }
  if (agentCancelled) { emit(@{@"ok": @NO, @"error": @"interrupted"}); return 0; }
  [browser activateWithOptions:NSApplicationActivateIgnoringOtherApps];
  emit(@{@"ok": @YES, @"bundleId": bundleId});
  return 0;
}

static int commandActivate(NSString *target) {
  NSRunningApplication *app = nil;
  if ([target length] == 0) {
    emit(@{@"ok" : @NO, @"error" : @"empty-target"});
    return 0;
  }
  if ([target rangeOfCharacterFromSet:[NSCharacterSet decimalDigitCharacterSet]].location == 0) {
    app = [NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)[target intValue]];
  }
  if (!app) {
    NSArray<NSRunningApplication *> *apps =
        [NSRunningApplication runningApplicationsWithBundleIdentifier:target];
    if ([apps count] > 0) app = apps[0];
  }
  if (!app) {
    NSArray<NSRunningApplication *> *apps = [[NSWorkspace sharedWorkspace] runningApplications];
    for (NSRunningApplication *candidate in apps) {
      if ([[candidate localizedName] isEqualToString:target]) {
        app = candidate;
        break;
      }
    }
  }
  if (!app) {
    emit(@{@"ok" : @NO, @"error" : @"app-not-running"});
    return 0;
  }
  BOOL activated = [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
  emit(@{@"ok" : @(activated), @"pid" : @([app processIdentifier])});
  return 0;
}

/**
 * Opens an application by name, bundle id or path, starting it if needed.
 *
 * `activate` only reaches something that is already running, which made "open
 * Telegram" impossible whenever Telegram was closed: the only route left was to
 * hunt for its Dock icon and click a pixel. That is the wrong tool for the job —
 * the system has a first-class answer for "open this application", and it does
 * not depend on the icon being visible, the Dock being where it was, or the
 * pointer landing accurately.
 *
 * Resolution order is most specific first: an existing path, then a bundle id,
 * then a display name matched against installed and running applications. The
 * answer names what actually came forward so the caller can verify the result
 * against the screen instead of assuming the launch worked.
 */
static int commandLaunch(NSString *target) {
  if ([target length] == 0) {
    emit(@{@"ok" : @NO, @"error" : @"empty-target"});
    return 0;
  }
  NSWorkspace *workspace = [NSWorkspace sharedWorkspace];
  NSURL *url = nil;

  if ([target hasPrefix:@"/"]) {
    url = [NSURL fileURLWithPath:target];
  }
  if (!url) {
    url = [workspace URLForApplicationWithBundleIdentifier:target];
  }
  if (!url) {
    // A display name is what the model reads off the Dock and the screen, so it
    // is the shape most requests arrive in. Compare case- and diacritic-
    // insensitively: the label came from a downscaled screenshot.
    NSString *wanted = [target stringByTrimmingCharactersInSet:
        [NSCharacterSet whitespaceAndNewlineCharacterSet]];
    NSMutableArray<NSURL *> *candidates = [NSMutableArray array];
    NSString *directories = @"/Applications:/Applications/Utilities:/System/Applications:"
        @"/System/Applications/Utilities:~/Applications";
    for (NSString *directory in [directories componentsSeparatedByString:@":"]) {
      NSString *expanded = [directory stringByExpandingTildeInPath];
      NSArray<NSString *> *entries =
          [[NSFileManager defaultManager] contentsOfDirectoryAtPath:expanded error:NULL];
      for (NSString *entry in entries) {
        if (![[entry pathExtension] isEqualToString:@"app"]) continue;
        NSString *name = [entry stringByDeletingPathExtension];
        if ([name compare:wanted options:NSCaseInsensitiveSearch | NSDiacriticInsensitiveSearch] ==
            NSOrderedSame) {
          [candidates addObject:[NSURL fileURLWithPath:
              [expanded stringByAppendingPathComponent:entry]]];
        }
      }
    }
    if ([candidates count] == 0) {
      for (NSRunningApplication *candidate in [workspace runningApplications]) {
        NSString *name = [candidate localizedName];
        if (name && [name compare:wanted options:NSCaseInsensitiveSearch |
            NSDiacriticInsensitiveSearch] == NSOrderedSame) {
          url = [candidate bundleURL];
          break;
        }
      }
    }
    if (!url && [candidates count] > 0) url = candidates[0];
  }

  if (!url) {
    emit(@{@"ok" : @NO, @"error" : @"app-not-found", @"target" : target});
    return 0;
  }
  if (agentCancelled) { emit(@{@"ok" : @NO, @"error" : @"interrupted"}); return 0; }

  NSRunningApplication *app = [workspace launchApplicationAtURL:url
    options:NSWorkspaceLaunchDefault configuration:@{} error:NULL];
  if (!app) {
    // Already running and simply not launched again is not a failure: fall back
    // to whatever is running from that bundle so the answer still names a pid.
    NSArray<NSRunningApplication *> *running =
        [NSRunningApplication runningApplicationsWithBundleIdentifier:
            [[NSBundle bundleWithURL:url] bundleIdentifier] ?: @""];
    if ([running count] > 0) app = running[0];
  }
  if (!app) {
    emit(@{@"ok" : @NO, @"error" : @"launch-failed", @"target" : target});
    return 0;
  }
  if (agentCancelled) { emit(@{@"ok" : @NO, @"error" : @"interrupted"}); return 0; }
  [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
  emit(@{@"ok" : @YES,
         @"pid" : @([app processIdentifier]),
         @"bundleId" : [app bundleIdentifier] ?: @"",
         @"name" : [app localizedName] ?: @""});
  return 0;
}

static int commandCursor(void) {
  NSPoint point = [NSEvent mouseLocation];
  NSScreen *screen = nil;
  for (NSScreen *candidate in [NSScreen screens]) {
    NSRect frame = [candidate frame];
    if (NSPointInRect(point, frame)) {
      screen = candidate;
      break;
    }
  }
  if (!screen) screen = [NSScreen mainScreen];
  NSRect frame = screen ? [screen frame] : NSZeroRect;
  // AppKit uses bottom-left origin; Electron works in top-left screen coordinates.
  double flippedY = NSMaxY(frame) - point.y;
  emit(@{
    @"ok" : @YES,
    @"x" : @(point.x),
    @"y" : @(flippedY),
    @"screen" : @{
      @"x" : @(frame.origin.x),
      @"y" : @(NSMaxY([[NSScreen mainScreen] frame]) - NSMaxY(frame)),
      @"width" : @(frame.size.width),
      @"height" : @(frame.size.height)
    },
    @"scale" : @(screen ? [screen backingScaleFactor] : 1.0)
  });
  return 0;
}

static int commandApps(void) {
  NSMutableArray *result = [NSMutableArray array];
  for (NSRunningApplication *candidate in [[NSWorkspace sharedWorkspace] runningApplications]) {
    if ([candidate activationPolicy] != NSApplicationActivationPolicyRegular) continue;
    NSString *bundleId = [candidate bundleIdentifier];
    NSString *name = [candidate localizedName];
    if (!bundleId || !name) continue;
    [result addObject:@{@"bundleId" : bundleId, @"name" : name}];
  }
  NSArray *sorted = [result sortedArrayUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
    return [a[@"name"] localizedCaseInsensitiveCompare:b[@"name"]];
  }];
  emit(@{@"ok" : @YES, @"apps" : sorted});
  return 0;
}

static int commandPermissions(BOOL request) {
  BOOL accessibility = AXIsProcessTrusted();
  if (request && !accessibility) {
    NSDictionary *options = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt : @YES};
    accessibility = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
  }
  BOOL screen = CGPreflightScreenCaptureAccess();
  if (request && !screen) {
    screen = CGRequestScreenCaptureAccess();
  }
  emit(@{
    @"ok" : @YES,
    @"accessibility" : @(accessibility),
    @"screenRecording" : @(screen),
    @"version" : @"1"
  });
  return 0;
}

// MARK: - Push-to-talk

// `globalShortcut` in Electron only reports the press, never the release, which
// is exactly half of what hold-to-talk needs. A CGEventTap gives both edges and
// — importantly — lets us swallow the key so the combination does not also reach
// the frontmost app. The tap dies after a macOS timeout, so it is re-enabled in
// place and reported, instead of silently going deaf.

typedef struct {
  int64_t keyCode;
  CGEventFlags flags;
  BOOL holding;
  BOOL swallow;
  CFMachPortRef tap;
} VoiceTapState;

static const CGEventFlags kVoiceModifierMask =
    kCGEventFlagMaskCommand | kCGEventFlagMaskAlternate | kCGEventFlagMaskControl | kCGEventFlagMaskShift;

static BOOL voiceModifiersMatch(CGEventFlags actual, CGEventFlags required) {
  return (actual & kVoiceModifierMask) == (required & kVoiceModifierMask);
}

static CGEventRef voiceTapCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event,
                                   void *info) {
  VoiceTapState *state = (VoiceTapState *)info;
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (state->tap) CGEventTapEnable(state->tap, true);
    if (state->holding) {
      state->holding = NO;
      emit(@{@"event" : @"cancel"});
    }
    emit(@{@"event" : @"reenabled"});
    return event;
  }

  // The helper is not a GUI app: it cannot see key events it did not tap for,
  // so Escape is handled here to abort a recording without sending it.
  if (type == kCGEventKeyDown) {
    int64_t code = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    if (code == (int64_t)kVK_Escape && state->holding) {
      state->holding = NO;
      emit(@{@"event" : @"cancel"});
      return event;
    }
    if (code == state->keyCode && voiceModifiersMatch(CGEventGetFlags(event), state->flags)) {
      if (!state->holding) {
        state->holding = YES;
        emit(@{@"event" : @"press"});
      }
      return state->swallow ? NULL : event;
    }
    return event;
  }

  if (type == kCGEventKeyUp) {
    int64_t code = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    if (code == state->keyCode && state->holding) {
      state->holding = NO;
      emit(@{@"event" : @"release"});
      return state->swallow ? NULL : event;
    }
  }
  return event;
}

static int commandVoice(int64_t keyCode, CGEventFlags flags, BOOL swallow) {
  if (!AXIsProcessTrusted()) {
    emit(@{@"ok" : @NO, @"error" : @"accessibility-denied"});
    return 0;
  }

  VoiceTapState state = {.keyCode = keyCode, .flags = flags, .holding = NO, .swallow = swallow, .tap = NULL};
  CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp);
  CFMachPortRef tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap,
                                       kCGEventTapOptionDefault, mask, voiceTapCallback, &state);
  if (!tap) {
    emit(@{@"ok" : @NO, @"error" : @"tap-create-failed"});
    return 0;
  }
  state.tap = tap;
  CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
  CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
  CGEventTapEnable(tap, true);
  emit(@{@"ok" : @YES, @"event" : @"ready", @"keyCode" : @(keyCode), @"flags" : @((long long)flags)});
  CFRunLoopRun();

  CFRelease(source);
  CFRelease(tap);
  return 0;
}

// MARK: - Trackpad gestures

// Three fingers on the trackpad are two different actions, and the difference is
// time: a short contact is a tap (it opens the card), a longer one is a hold (it
// records). macOS has no public API for "what is the trackpad doing right now",
// so the raw contact stream comes from MultitouchSupport. It is a private
// framework, hence `dlopen`: the helper must start even on a machine where the
// framework has moved or is missing, and just report that gestures are off.
//
// The framework prints its own banner to stdout ("*** Recognized ... family***")
// the moment the device is opened, which would corrupt the line protocol, so the
// protocol is written to a saved duplicate of the original stdout and fd 1 is
// pointed at /dev/null before the framework is touched.

// The classification lives in `gesture.h`: it is the part worth replaying against
// recorded contact frames (`scripts/gesture.test.c`, run with
// `npm run test:gesture`), and it has no business knowing about JSON, processes
// or the framework.
/** Set by `SMARTCURSOR_GESTURE_DEBUG`: every edge carries the contact age. */
static BOOL gGestureDebug = NO;
static int gGestureJsonFd = -1;

static void emitGesture(NSDictionary *payload) {
  if (gGestureJsonFd < 0) return;
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&error];
  if (error || !data) return;
  const char *bytes = [data bytes];
  size_t length = [data length];
  size_t written = 0;
  while (written < length) {
    ssize_t chunk = write(gGestureJsonFd, bytes + written, length - written);
    if (chunk <= 0) return;
    written += (size_t)chunk;
  }
  write(gGestureJsonFd, "\n", 1);
}

static void emitGestureEvent(GestureEventKind kind, double heldMs, void *context) {
  (void)context;
  const char *name = NULL;
  switch (kind) {
    case kGestureEventTap:
      name = "tap";
      break;
    case kGestureEventPress:
      name = "press";
      break;
    case kGestureEventRelease:
      name = "release";
      break;
    case kGestureEventCancel:
      name = "cancel";
      break;
    default:
      return;
  }
  if (gGestureDebug && heldMs >= 0) {
    emitGesture(@{@"event" : [NSString stringWithUTF8String:name], @"heldMs" : @(heldMs)});
  } else {
    emitGesture(@{@"event" : [NSString stringWithUTF8String:name]});
  }
}

static GestureState gGestureState;

// The device handle and the callback signature come from the framework, not from
// `gesture.h`: that header only knows about contacts.
typedef void *MTDeviceRef;
typedef int (*MTContactCallback)(MTDeviceRef device, MTTouch *touches, int count, double timestamp,
                                 int frame);
typedef CFArrayRef (*MTDeviceCreateListFn)(void);
typedef void (*MTRegisterContactFrameCallbackFn)(MTDeviceRef device, MTContactCallback callback);
typedef void (*MTDeviceStartFn)(MTDeviceRef device, int mode);

static int gestureContactCallback(MTDeviceRef device, MTTouch *touches, int count, double timestamp,
                                  int frame) {
  // Monotonic, and unaffected by the wall clock, which may jump mid-gesture.
  double now = [NSProcessInfo processInfo].systemUptime;
  gestureHandleFrame(&gGestureState, touches, count, now);
  return 0;
}

static int commandGesture(int fingers, double holdMs) {
  // The protocol keeps its own channel before the framework can write to fd 1.
  gGestureJsonFd = dup(STDOUT_FILENO);
  int devnull = open("/dev/null", O_WRONLY);
  if (devnull >= 0) {
    dup2(devnull, STDOUT_FILENO);
    close(devnull);
  }

  // 6% of the pad is roughly 5 mm: past that the fingers are going somewhere,
  // which is a swipe (Mission Control, an app switch), not a tap or a hold.
  gestureInit(&gGestureState, fingers, holdMs, 0.06, emitGestureEvent, NULL);
  gGestureDebug = getenv("SMARTCURSOR_GESTURE_DEBUG") != NULL;

  void *handle = dlopen(
      "/System/Library/PrivateFrameworks/MultitouchSupport.framework/MultitouchSupport", RTLD_LAZY);
  if (!handle) {
    emitGesture(@{@"ok" : @NO, @"error" : @"multitouch-unavailable"});
    return 0;
  }
  MTDeviceCreateListFn list = (MTDeviceCreateListFn)dlsym(handle, "MTDeviceCreateList");
  MTRegisterContactFrameCallbackFn registerCallback =
      (MTRegisterContactFrameCallbackFn)dlsym(handle, "MTRegisterContactFrameCallback");
  MTDeviceStartFn start = (MTDeviceStartFn)dlsym(handle, "MTDeviceStart");
  if (!list || !registerCallback || !start) {
    emitGesture(@{@"ok" : @NO, @"error" : @"multitouch-unavailable"});
    return 0;
  }

  CFArrayRef devices = list();
  if (!devices || CFArrayGetCount(devices) == 0) {
    if (devices) CFRelease(devices);
    // No trackpad: a desktop Mac with a mouse only. Not an error to shout about,
    // but the caller has to know gestures will never fire.
    emitGesture(@{@"ok" : @NO, @"error" : @"no-trackpad"});
    return 0;
  }

  for (CFIndex i = 0; i < CFArrayGetCount(devices); i++) {
    MTDeviceRef device = (MTDeviceRef)CFArrayGetValueAtIndex(devices, i);
    registerCallback(device, gestureContactCallback);
    start(device, 0);
  }
  emitGesture(@{@"ok" : @YES, @"event" : @"ready", @"fingers" : @(fingers)});

  // The contact frames arrive on the framework's own thread, so the main thread
  // has nothing to service — and a run loop with no sources returns immediately,
  // which would end the process right after `ready`. A far-future timer is the
  // cheapest way to keep it parked here until the process is killed.
  CFRunLoopTimerRef keepAlive =
      CFRunLoopTimerCreate(kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + 3600, 3600, 0, 0, NULL,
                           NULL);
  if (keepAlive) CFRunLoopAddTimer(CFRunLoopGetCurrent(), keepAlive, kCFRunLoopDefaultMode);
  CFRunLoopRun();
  if (keepAlive) CFRelease(keepAlive);

  CFRelease(devices);
  dlclose(handle);
  return 0;
}

// MARK: - Agent: precise targeting
//
// A click is only as good as the rectangle it lands in. The model returns a
// point in a downscaled picture, and a language model's point is routinely 20–60
// points away from the control it describes — enough to hit the icon next to it
// or the empty space between two buttons. The screen has no such ambiguity: the
// Accessibility API knows the exact rectangle of every button, so the point only
// has to answer "which rectangle", and the click goes to the rectangle's centre.
//
// `probe` reports both halves of that:
//   * `chain`   — the element under a concrete point and its ancestors, so a
//                 static text inside a button can be resolved to the button;
//   * `targets` — everything actionable in the focused window and the menu bar,
//                 so "the button labelled «Экспорт»" can be found even when the
//                 model's point missed it altogether.
//
// Reading the tree is not free: every attribute is an IPC round trip into the
// target app, and a browser window can hold thousands of elements. The walk is
// bounded by depth, count and a time budget, and the caller caches the result for
// the duration of a plan instead of asking per pixel.

/** String-ish attribute, truncated: AX values can be whole documents. */
static NSString *axText(AXUIElementRef element, CFStringRef attribute) {
  CFTypeRef value = NULL;
  if (!element) return nil;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess || !value) {
    return nil;
  }
  NSString *text = nil;
  CFTypeID type = CFGetTypeID(value);
  if (type == CFStringGetTypeID()) {
    text = [NSString stringWithString:(__bridge NSString *)value];
  } else if (type == CFNumberGetTypeID() || type == CFBooleanGetTypeID()) {
    text = [NSString stringWithFormat:@"%@", (__bridge id)value];
  }
  CFRelease(value);
  if (text.length == 0) return nil;
  // A multi-line value is a document, not a label: one line is all a target needs.
  text = [text stringByReplacingOccurrencesOfString:@"\n" withString:@" "];
  if (text.length > 120) text = [[text substringToIndex:119] stringByAppendingString:@"…"];
  return text;
}

static NSArray<NSString *> *axActions(AXUIElementRef element) {
  CFArrayRef actions = NULL;
  if (!element) return @[];
  if (AXUIElementCopyActionNames(element, &actions) != kAXErrorSuccess || !actions) return @[];
  NSMutableArray<NSString *> *names = [NSMutableArray array];
  for (id name in (__bridge NSArray *)actions) {
    if ([name isKindOfClass:[NSString class]]) [names addObject:name];
  }
  CFRelease(actions);
  return names;
}

/**
 * The element's rectangle in global screen points, top-left origin.
 *
 * AX already speaks that space — the same one `CGEventCreateMouseEvent` and
 * Electron's `screen` module use — so no flipping happens here. An element
 * without a usable frame is reported without one instead of with a zero rect:
 * "clicks to 0,0" is worse than "unknown".
 */
static NSDictionary *axFrame(AXUIElementRef element) {
  AXValueRef positionValue = NULL;
  AXValueRef sizeValue = NULL;
  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  if (!element) return nil;
  if (AXUIElementCopyAttributeValue(element, kAXPositionAttribute, (CFTypeRef *)&positionValue) !=
          kAXErrorSuccess ||
      !positionValue) {
    return nil;
  }
  if (AXUIElementCopyAttributeValue(element, kAXSizeAttribute, (CFTypeRef *)&sizeValue) !=
          kAXErrorSuccess ||
      !sizeValue) {
    CFRelease(positionValue);
    return nil;
  }
  BOOL ok = AXValueGetValue(positionValue, (AXValueType)kAXValueCGPointType, &position) &&
            AXValueGetValue(sizeValue, (AXValueType)kAXValueCGSizeType, &size);
  CFRelease(positionValue);
  CFRelease(sizeValue);
  if (!ok) return nil;
  if (!isfinite(position.x) || !isfinite(position.y) || !isfinite(size.width) ||
      !isfinite(size.height)) {
    return nil;
  }
  // Smaller than this cannot be hit on purpose, and zero-sized elements are
  // usually layout containers that happen to expose a press action.
  if (size.width < 2 || size.height < 2) return nil;
  return @{
    @"x" : @(position.x),
    @"y" : @(position.y),
    @"width" : @(size.width),
    @"height" : @(size.height)
  };
}

/** Roles that take text; used to tell "the field has focus" from "the button does". */
static BOOL axRoleIsField(NSString *role) {
  return [role isEqualToString:@"AXTextField"] || [role isEqualToString:@"AXTextArea"] ||
         [role isEqualToString:@"AXComboBox"] || [role isEqualToString:@"AXSearchField"];
}

/** Roles that are clicked by nature, for elements that forgot to expose AXPress. */
static BOOL axRoleIsControl(NSString *role) {
  static NSSet<NSString *> *roles = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    roles = [NSSet setWithArray:@[
      @"AXButton", @"AXMenuItem", @"AXMenuBarItem", @"AXMenuButton", @"AXCheckBox",
      @"AXRadioButton", @"AXPopUpButton", @"AXComboBox", @"AXLink", @"AXTab",
      @"AXToolbarButton", @"AXDisclosureTriangle", @"AXSegmentedControl", @"AXIncrementor",
      @"AXSlider", @"AXColorWell", @"AXCell", @"AXRow", @"AXDockItem"
    ]];
  });
  return [roles containsObject:role];
}

static NSDictionary *axDescribe(AXUIElementRef element, NSArray<NSString *> *actions) {
  NSMutableDictionary *info = [NSMutableDictionary dictionary];
  NSString *role = axText(element, kAXRoleAttribute) ?: @"";
  info[@"role"] = role;
  NSString *subrole = axText(element, kAXSubroleAttribute);
  if (subrole) info[@"subrole"] = subrole;
  NSString *title = axText(element, kAXTitleAttribute);
  if (title) info[@"title"] = title;
  NSString *value = axText(element, kAXValueAttribute);
  if (value) info[@"value"] = value;
  NSString *described = axText(element, kAXDescriptionAttribute);
  if (described) info[@"description"] = described;
  if (!title && !described && (axRoleIsControl(role) || [actions containsObject:@"AXPress"])) {
    NSString *help = axText(element, kAXHelpAttribute);
    if (help.length > 0 && help.length <= 60) info[@"help"] = help;
  }
  NSString *roleDescription = axText(element, kAXRoleDescriptionAttribute);
  if (roleDescription) info[@"roleDescription"] = roleDescription;
  NSDictionary *frame = axFrame(element);
  if (frame) info[@"frame"] = frame;
  BOOL pressable = [actions containsObject:@"AXPress"];
  BOOL editable = axRoleIsField(role);
  // A field also takes AXValue but so does a static label; the role is the only
  // honest signal that text can be typed into the element.
  info[@"pressable"] = (pressable || axRoleIsControl(role)) ? @YES : @NO;
  info[@"editable"] = editable ? @YES : @NO;
  if (actions.count > 0) {
    info[@"actions"] = [actions subarrayWithRange:NSMakeRange(0, MIN(actions.count, (NSUInteger)6))];
  }
  return info;
}

/**
 * The element under a point, walking up through its parents.
 *
 * Innermost first: the caller wants the *deepest* thing that is actually
 * clickable, which is the first entry in this list with a press action — a
 * static text inside a button resolves to the button, and a button inside a
 * toolbar stays the button instead of becoming the toolbar.
 */
static NSArray *axChildren(AXUIElementRef element);

static NSArray<NSDictionary *> *axChainAtPoint(double x, double y,
                                               NSMutableArray<NSDictionary *> *neighbors) {
  NSMutableArray<NSDictionary *> *chain = [NSMutableArray array];
  AXUIElementRef system = AXUIElementCreateSystemWide();
  if (!system) return chain;
  AXUIElementSetMessagingTimeout(system, 0.3);
  AXUIElementRef element = NULL;
  AXError error = AXUIElementCopyElementAtPosition(system, (float)x, (float)y, &element);
  CFRelease(system);
  if (error != kAXErrorSuccess || !element) return chain;

  for (int depth = 0; depth < 6 && element; depth++) {
    NSMutableDictionary *info = [axDescribe(element, axActions(element)) mutableCopy];
    pid_t owner = 0;
    if (AXUIElementGetPid(element, &owner) == kAXErrorSuccess) info[@"pid"] = @(owner);
    [chain addObject:info];

    // The hit test can land on a system surface owned by another process.
    // Include neighboring icons so a near miss can resolve by name.
    if (depth == 1 && [chain.firstObject[@"role"] isEqual:@"AXDockItem"]) {
      CFTimeInterval deadline = CFAbsoluteTimeGetCurrent() + 0.25;
      for (id sibling in axChildren(element)) {
        if (neighbors.count >= 64 || CFAbsoluteTimeGetCurrent() >= deadline) break;
        AXUIElementRef candidate = (__bridge AXUIElementRef)sibling;
        if (![axText(candidate, kAXRoleAttribute) isEqual:@"AXDockItem"]) continue;
        NSDictionary *item = axDescribe(candidate, axActions(candidate));
        if (item[@"frame"]) [neighbors addObject:item];
      }
    }

    CFTypeRef parentValue = NULL;
    if (AXUIElementCopyAttributeValue(element, kAXParentAttribute, &parentValue) !=
            kAXErrorSuccess ||
        !parentValue) {
      CFRelease(element);
      element = NULL;
      break;
    }
    // Ownership moves to the parent: the copy takes one reference, the child's
    // reference is released here.
    CFRelease(element);
    element = (AXUIElementRef)parentValue;
  }
  if (element) CFRelease(element);
  return chain;
}

static NSArray *axChildren(AXUIElementRef element) {
  CFTypeRef value = NULL;
  if (!element) return nil;
  if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &value) != kAXErrorSuccess ||
      !value) {
    return nil;
  }
  if (CFGetTypeID(value) != CFArrayGetTypeID()) {
    CFRelease(value);
    return nil;
  }
  NSArray *children = [(__bridge NSArray *)value copy];
  CFRelease(value);
  return children;
}

/** Adds a child reference to the queue; the dictionary owns it from here on. */
static void axEnqueue(NSMutableArray<NSDictionary *> *queue, id element, int depth) {
  if (!element) return;
  [queue addObject:@{@"el" : element, @"depth" : @(depth)}];
}

/**
 * Everything actionable the app owns: the menu bar, the focused window, and
 * every other window it has on screen.
 *
 * Three roots, and all three are needed. The menu bar is where a native menu's
 * items live — the most common *second* step of a plan ("Файл" → "Экспорт"), and
 * the smallest targets a guess in the picture cannot hit. The focused window is
 * where the model was looking. Every *other* window is where the plan is about to
 * go: a popup menu, a sheet, an open dialog and a second document are all
 * separate windows, and a resolver that only knew the focused one could never
 * find the menu item it had just opened by clicking the menu — which is exactly
 * the step that used to fall back to the model's own pixel and miss.
 *
 * The walk is breadth-first, bounded by depth, node and time, because every
 * attribute read is an IPC round trip into the target app. A closed menu reports
 * no children, so the menu bar costs almost nothing until a menu is open.
 */
static NSArray<NSDictionary *> *axCollectTargets(pid_t pid, double budgetMs) {
  NSMutableArray<NSDictionary *> *targets = [NSMutableArray array];
  NSMutableSet<NSString *> *seen = [NSMutableSet set];
  AXUIElementRef application = AXUIElementCreateApplication(pid);
  if (!application) return targets;
  // An app that stopped responding must not hang the plan: every attribute read
  // gives up after this, and the walk goes on with what it already has.
  AXUIElementSetMessagingTimeout(application, 0.4);

  CFTimeInterval started = CFAbsoluteTimeGetCurrent();
  NSMutableArray<NSDictionary *> *queue = [NSMutableArray array];

  CFTypeRef menuBarValue = NULL;
  if (AXUIElementCopyAttributeValue(application, kAXMenuBarAttribute, &menuBarValue) ==
          kAXErrorSuccess &&
      menuBarValue) {
    axEnqueue(queue, CFBridgingRelease(menuBarValue), 0);
  }

  // The focused window first, so a truncated walk still holds what the model was
  // looking at; then the rest, which is where the next step of the plan lives.
  AXUIElementRef focusedWindow = NULL;
  if (AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute,
                                   (CFTypeRef *)&focusedWindow) != kAXErrorSuccess) {
    focusedWindow = NULL;
  }
  CFTypeRef windowsValue = NULL;
  NSArray<id> *windows = nil;
  if (AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &windowsValue) ==
          kAXErrorSuccess &&
      windowsValue) {
    windows = (__bridge_transfer NSArray<id> *)windowsValue;
  }
  NSMutableArray<id> *ordered = [NSMutableArray array];
  if (focusedWindow) [ordered addObject:(__bridge id)focusedWindow];
  for (id window in windows) {
    if (focusedWindow && CFEqual((__bridge CFTypeRef)window, focusedWindow)) continue;
    [ordered addObject:window];
  }
  if (focusedWindow) CFRelease(focusedWindow);
  for (id window in ordered) axEnqueue(queue, window, 0);
  if (ordered.count > 0) {
    CFRelease(application);
  } else {
    // An app with no windows at all (a menu-only agent): walk the app element, so
    // its menu bar item is still reachable.
    axEnqueue(queue, CFBridgingRelease(application), 0);
  }

  for (NSUInteger index = 0; index < queue.count; index++) {
    if (index > 4000) break;
    if (CFAbsoluteTimeGetCurrent() - started > budgetMs / 1000.0) break;

    NSDictionary *entry = queue[index];
    AXUIElementRef element = (__bridge AXUIElementRef)entry[@"el"];
    int depth = [entry[@"depth"] intValue];
    NSArray<NSString *> *actions = axActions(element);
    NSString *role = axText(element, kAXRoleAttribute) ?: @"";
    BOOL editable = axRoleIsField(role);
    BOOL clickable = [actions containsObject:@"AXPress"] || axRoleIsControl(role);
    if (clickable || editable) {
      NSMutableDictionary *info = [axDescribe(element, actions) mutableCopy];
      if (info[@"frame"]) {
        // Chromium exposes the same inline link through several parents; the
        // duplicates are one target and would only split the match's confidence.
        NSDictionary *frame = info[@"frame"];
        NSString *key = [NSString stringWithFormat:@"%@|%@|%@|%@|%.0f,%.0f,%.0f,%.0f",
                                                   info[@"role"] ?: @"", info[@"title"] ?: @"",
                                                   info[@"value"] ?: @"", info[@"description"] ?: @"",
                                                   [frame[@"x"] doubleValue], [frame[@"y"] doubleValue],
                                                   [frame[@"width"] doubleValue],
                                                   [frame[@"height"] doubleValue]];
        if (![seen containsObject:key]) {
          [seen addObject:key];
          info[@"depth"] = @(depth);
          [targets addObject:info];
        }
        // Enough with the list: a model's plan has six steps at most, and a
        // thousand candidates would only make matching slower and less certain.
        if (targets.count >= 400) break;
      }
    }
    // Web content nests far deeper than a native control tree: a button in a
    // modern page sits thirty levels down, and stopping at eighteen was another
    // reason a labelled button was never found. The node and time budgets are
    // what actually bound the walk.
    if (depth >= 40) continue;
    for (id child in axChildren(element)) {
      axEnqueue(queue, child, depth + 1);
    }
  }
  return targets;
}

static NSDictionary *axFocusedElement(pid_t pid) {
  AXUIElementRef focused = NULL;
  AXUIElementRef system = AXUIElementCreateSystemWide();
  if (system) {
    AXUIElementSetMessagingTimeout(system, 0.3);
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute, &value) ==
            kAXErrorSuccess &&
        value) {
      focused = (AXUIElementRef)value;
    }
    CFRelease(system);
  }
  if (!focused) {
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    if (application) {
      AXUIElementSetMessagingTimeout(application, 0.3);
      CFTypeRef value = NULL;
      if (AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute, &value) ==
              kAXErrorSuccess &&
          value) {
        focused = (AXUIElementRef)value;
      }
      CFRelease(application);
    }
  }
  if (!focused) return nil;
  NSMutableDictionary *info = [axDescribe(focused, axActions(focused)) mutableCopy];
  pid_t owner = 0;
  if (AXUIElementGetPid(focused, &owner) == kAXErrorSuccess) info[@"pid"] = @(owner);
  CFRelease(focused);
  return info;
}

static int commandProbe(pid_t requestedPid, double x, double y) {
  if (!AXIsProcessTrusted()) {
    emit(@{@"ok" : @NO, @"error" : @"accessibility-denied"});
    return 0;
  }
  CFTimeInterval started = CFAbsoluteTimeGetCurrent();
  pid_t pid = requestedPid;
  if (pid <= 0) {
    NSRunningApplication *front = [[NSWorkspace sharedWorkspace] frontmostApplication];
    pid = front ? [front processIdentifier] : 0;
  }
  if (pid <= 0) {
    emit(@{@"ok" : @NO, @"error" : @"no-target-app"});
    return 0;
  }  NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  // Chromium-based apps (Chrome, Electron, Slack, VS Code) keep their accessibility
  // tree switched off until something that looks like an assistive client shows
  // up: without this, a browser window reports one big scroll area and no buttons,
  // and every click in it falls back to the model's own coordinates. Both
  // attributes are the documented-in-practice way to ask for the tree; an app that
  // does not know them ignores the write.
  AXUIElementRef appElement = AXUIElementCreateApplication(pid);
  if (appElement) {
    AXUIElementSetAttributeValue(appElement, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);
    AXUIElementSetAttributeValue(appElement, CFSTR("AXManualAccessibility"), kCFBooleanTrue);
    CFRelease(appElement);
  }
  NSMutableDictionary *payload = [NSMutableDictionary dictionary];
  payload[@"ok"] = @YES;
  payload[@"pid"] = @(pid);
  payload[@"app"] = [application localizedName] ?: @"";
  NSMutableArray<NSDictionary *> *targets = [NSMutableArray array];
  if (isfinite(x) && isfinite(y)) payload[@"chain"] = axChainAtPoint(x, y, targets);
  [targets addObjectsFromArray:axCollectTargets(pid, 600)];
  payload[@"targets"] = targets;
  NSDictionary *focused = axFocusedElement(pid);
  if (focused) payload[@"focused"] = focused;
  payload[@"elapsedMs"] = @((CFAbsoluteTimeGetCurrent() - started) * 1000.0);
  emit(payload);
  return 0;
}

/**
 * What has the keyboard right now.
 *
 * A separate command from `probe` because it is asked a different question and
 * asked often: "the click was supposed to focus the field — did it?" Reading only
 * the focused element costs one round trip instead of a whole tree walk, which is
 * the difference between a check the runner can do before every keystroke and one
 * it would have to skip.
 */
static int commandFocused(pid_t requestedPid) {
  if (!AXIsProcessTrusted()) {
    emit(@{@"ok" : @NO, @"error" : @"accessibility-denied"});
    return 0;
  }
  pid_t pid = requestedPid;
  if (pid <= 0) {
    NSRunningApplication *front = [[NSWorkspace sharedWorkspace] frontmostApplication];
    pid = front ? [front processIdentifier] : 0;
  }
  NSMutableDictionary *payload = [NSMutableDictionary dictionary];
  payload[@"ok"] = @YES;
  payload[@"pid"] = @(pid);
  NSDictionary *focused = pid > 0 ? axFocusedElement(pid) : nil;
  if (focused) payload[@"focused"] = focused;
  emit(payload);
  return 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2) {
      emit(@{@"ok" : @NO, @"error" : @"missing-command"});
      return 1;
    }
    const char *command = argv[1];
    if (strcmp(command, "open-browser") == 0) signal(SIGTERM, cancelAgentInput);
    if (strcmp(command, "input") == 0 && argc >= 6) {
      signal(SIGTERM, cancelAgentInput);
      agentExpectedPid = (pid_t)strtol(argv[2], NULL, 10);
      agentExpectedWindow = strtol(argv[3], NULL, 10);
      double x, y, width, height;
      agentHasExpectedBounds = sscanf(argv[4], "%lf,%lf,%lf,%lf", &x, &y, &width, &height) == 4;
      if (agentHasExpectedBounds) agentExpectedBounds = CGRectMake(x, y, width, height);
      if (agentExpectedPid <= 0 || !agentTargetMatches()) {
        emit(@{@"ok": @NO, @"error": @"target-changed"});
        return 0;
      }
      argv += 4;
      argc -= 4;
      command = argv[1];
    }
    if (strcmp(command, "permissions") == 0) return commandPermissions(NO);
    if (strcmp(command, "request-permissions") == 0) return commandPermissions(YES);
    if (strcmp(command, "cursor") == 0) return commandCursor();
    if (strcmp(command, "apps") == 0) return commandApps();
    if (strcmp(command, "front") == 0) return commandFront(0);
    if (strcmp(command, "window") == 0 && argc == 3) return commandFront((pid_t)strtol(argv[2], NULL, 10));
    if (strcmp(command, "open-browser") == 0) return commandOpenBrowser();
    if (strcmp(command, "copy") == 0) return commandKey("copy");
    if (strcmp(command, "paste") == 0) return commandKey("paste");
    if (strcmp(command, "activate") == 0) {
      NSString *target = argc > 2 ? [NSString stringWithUTF8String:argv[2]] : @"";
      return commandActivate(target);
    }
    if (strcmp(command, "launch") == 0) {
      // launch <name|bundleId|path> — opens the application, starting it if needed.
      NSString *target = argc > 2 ? [NSString stringWithUTF8String:argv[2]] : @"";
      return commandLaunch(target);
    }
    if (strcmp(command, "voice") == 0) {
      // voice <keyCode> <flags> [swallow]
      if (argc < 4) {
        emit(@{@"ok" : @NO, @"error" : @"missing-arguments"});
        return 1;
      }
      int64_t keyCode = strtoll(argv[2], NULL, 10);
      CGEventFlags flags = (CGEventFlags)strtoull(argv[3], NULL, 10);
      BOOL swallow = argc > 4 && strcmp(argv[4], "swallow") == 0;
      return commandVoice(keyCode, flags, swallow);
    }
    if (strcmp(command, "gesture") == 0) {
      // gesture <fingers> <holdMs>
      if (argc < 4) {
        emit(@{@"ok" : @NO, @"error" : @"missing-arguments"});
        return 1;
      }
      int fingers = (int)strtol(argv[2], NULL, 10);
      double holdMs = strtod(argv[3], NULL);
      if (fingers < 2 || fingers > 4 || holdMs < 100 || holdMs > 2000) {
        emit(@{@"ok" : @NO, @"error" : @"bad-arguments"});
        return 1;
      }
      return commandGesture(fingers, holdMs);
    }
    if (strcmp(command, "move") == 0) {
      // move <x> <y>
      if (argc < 4) {
        emit(@{@"ok" : @NO, @"error" : @"missing-arguments"});
        return 1;
      }
      if (agentRequireAccessibility()) return 0;
      if (!agentCanPost()) { emit(@{@"ok": @NO, @"error": @"interrupted"}); return 0; }
      agentMoveTo(strtod(argv[2], NULL), strtod(argv[3], NULL));
      emit(@{@"ok" : @YES});
      return 0;
    }
    if (strcmp(command, "click") == 0) {
      // click <x> <y> [left|right|double]
      if (argc < 4) {
        emit(@{@"ok" : @NO, @"error" : @"missing-arguments"});
        return 1;
      }
      if (agentRequireAccessibility()) return 0;
      if (!agentCanPost()) { emit(@{@"ok": @NO, @"error": @"interrupted"}); return 0; }
      const char *which = argc > 4 ? argv[4] : "left";
      CGMouseButton button = kCGMouseButtonLeft;
      int count = 1;
      if (strcmp(which, "right") == 0) button = kCGMouseButtonRight;
      if (strcmp(which, "double") == 0) count = 2;
      emit(agentClick(strtod(argv[2], NULL), strtod(argv[3], NULL), button, count));
      return 0;
    }
    if (strcmp(command, "drag") == 0) {
      // drag <x1> <y1> <x2> <y2>
      if (argc < 6) {
        emit(@{@"ok" : @NO, @"error" : @"missing-arguments"});
        return 1;
      }
      if (agentRequireAccessibility()) return 0;
      if (!agentCanPost()) { emit(@{@"ok": @NO, @"error": @"interrupted"}); return 0; }
      emit(@{@"ok" : @(agentDrag(strtod(argv[2], NULL), strtod(argv[3], NULL),
                                      strtod(argv[4], NULL), strtod(argv[5], NULL)))});
      return 0;
    }
    if (strcmp(command, "scroll") == 0) {
      // scroll <dx> <dy>
      if (argc < 4) {
        emit(@{@"ok" : @NO, @"error" : @"missing-arguments"});
        return 1;
      }
      if (agentRequireAccessibility()) return 0;
      if (!agentCanPost()) { emit(@{@"ok": @NO, @"error": @"interrupted"}); return 0; }
      agentScroll(strtod(argv[2], NULL), strtod(argv[3], NULL));
      emit(@{@"ok" : @YES});
      return 0;
    }
    if (strcmp(command, "key") == 0) {
      // key <keyCode> <flags>
      if (argc < 4) {
        emit(@{@"ok" : @NO, @"error" : @"missing-arguments"});
        return 1;
      }
      if (agentRequireAccessibility()) return 0;
      if (!agentCanPost()) { emit(@{@"ok": @NO, @"error": @"interrupted"}); return 0; }
      emit(@{@"ok" : @(agentKey(strtoll(argv[2], NULL, 10), (CGEventFlags)strtoull(argv[3], NULL, 10)))});
      return 0;
    }
    if (strcmp(command, "type") == 0) {
      // type <base64 utf8>
      // Base64 because the text is arbitrary Unicode and argv is not: a
      // Cyrillic word or a newline would arrive mangled or split the argument.
      if (argc < 3) {
        emit(@{@"ok" : @NO, @"error" : @"missing-arguments"});
        return 1;
      }
      if (agentRequireAccessibility()) return 0;
      if (!agentCanPost()) { emit(@{@"ok": @NO, @"error": @"interrupted"}); return 0; }
      NSString *encoded = [NSString stringWithUTF8String:argv[2]];
      NSData *decoded = [[NSData alloc] initWithBase64EncodedString:encoded ?: @"" options:0];
      NSString *text = decoded ? [[NSString alloc] initWithData:decoded encoding:NSUTF8StringEncoding]
                               : nil;
      if (!text) {
        emit(@{@"ok" : @NO, @"error" : @"bad-payload"});
        return 0;
      }
      emit(@{@"ok" : @(agentType(text))});
      return 0;
    }
    if (strcmp(command, "probe") == 0) {
      // probe [pid] [x y] — pid 0 means "the frontmost app", no x/y means "no
      // hit test, only the element list". Both are optional because the caller
      // sometimes knows the app but has no point yet.
      pid_t pid = 0;
      double x = NAN;
      double y = NAN;
      if (argc > 2) pid = (pid_t)strtol(argv[2], NULL, 10);
      if (argc > 4) {
        x = strtod(argv[3], NULL);
        y = strtod(argv[4], NULL);
      }
      return commandProbe(pid, x, y);
    }
    if (strcmp(command, "focused") == 0) {
      // focused [pid] — the element with the keyboard, for the pre-typing check.
      pid_t pid = argc > 2 ? (pid_t)strtol(argv[2], NULL, 10) : 0;
      return commandFocused(pid);
    }
    if (strcmp(command, "watch") == 0) {
      // watch [mouse]
      BOOL watchMouse = argc > 2 && strcmp(argv[2], "mouse") == 0;
      return commandWatch(watchMouse, argc > 2 && strcmp(argv[2], "interaction") == 0);
    }
    if (strcmp(command, "ping") == 0) {
      emit(@{@"ok" : @YES, @"version" : @"1"});
      return 0;
    }
    emit(@{@"ok" : @NO, @"error" : @"unknown-command"});
    return 1;
  }
}
