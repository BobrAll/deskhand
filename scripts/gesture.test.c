// Replays contact frames through the classifier the helper actually uses.
//
// The hard part of the three-finger gesture is not reading the trackpad, it is
// deciding when a contact is a tap and when it is a hold — and that decision is
// testable without a hand on the pad. This harness feeds the same `gesture.h`
// the helper compiles against, so a change that breaks a tap breaks this first.
//
// Run with `npm run test:gesture`.

#include <stdio.h>
#include <string.h>

#include "../src/main/native/gesture.h"

static int failures = 0;
static int checks = 0;

typedef struct {
  char events[16][24];
  double heldMs[16];
  int count;
} Log;

static Log gLog;

static void sink(GestureEventKind kind, double heldMs, void *context) {
  (void)context;
  const char *name = "none";
  switch (kind) {
    case kGestureEventTap: name = "tap"; break;
    case kGestureEventPress: name = "press"; break;
    case kGestureEventRelease: name = "release"; break;
    case kGestureEventCancel: name = "cancel"; break;
    default: return;
  }
  if (gLog.count < 16) {
    snprintf(gLog.events[gLog.count], sizeof(gLog.events[0]), "%s", name);
    gLog.heldMs[gLog.count] = heldMs;
    gLog.count++;
  }
}

static void logReset(void) { memset(&gLog, 0, sizeof(gLog)); }

/** Builds a frame from parallel arrays; states drive everything else. */
static void frame(GestureState *state, double now, int n, const int32_t *ids, const int32_t *states,
                  const float *xs, const float *ys) {
  MTTouch touches[16];
  memset(touches, 0, sizeof(touches));
  for (int i = 0; i < n; i++) {
    touches[i].identifier = ids[i];
    touches[i].state = states[i];
    touches[i].normalized.pos.x = xs[i];
    touches[i].normalized.pos.y = ys[i];
  }
  gestureHandleFrame(state, touches, n, now);
}

static void expect(const char *name, int expectedCount, const char *a, const char *b) {
  checks++;
  int ok = gLog.count == expectedCount;
  if (ok && expectedCount >= 1) ok = strcmp(gLog.events[0], a) == 0;
  if (ok && expectedCount >= 2) ok = strcmp(gLog.events[1], b) == 0;
  if (ok) {
    printf("  ok   %-46s", name);
    for (int i = 0; i < gLog.count; i++) printf(" %s@%.0fms", gLog.events[i], gLog.heldMs[i]);
    printf("\n");
  } else {
    failures++;
    printf("  FAIL %-46s expected %d [%s,%s], got %d:", name, expectedCount, a ? a : "",
           b ? b : "", gLog.count);
    for (int i = 0; i < gLog.count; i++) printf(" %s@%.0fms", gLog.events[i], gLog.heldMs[i]);
    printf("\n");
  }
}

/** A normal three-finger tap: fingers land, settle, lift, then the pad is empty. */
static void testTap(void) {
  GestureState s;
  gestureInit(&s, 3, 450, 0.06, sink, NULL);
  logReset();
  int32_t ids[3] = {1, 2, 3};
  float xs[3] = {0.40f, 0.45f, 0.50f};
  float ys[3] = {0.40f, 0.42f, 0.40f};
  int32_t down[3] = {1, 1, 1};
  int32_t rest[3] = {4, 4, 4};
  int32_t lift[3] = {5, 5, 5};
  double t = 100.0;
  frame(&s, t, 3, ids, down, xs, ys);
  for (int i = 0; i < 4; i++) frame(&s, t += 0.008, 3, ids, rest, xs, ys);
  frame(&s, t += 0.008, 3, ids, lift, xs, ys);
  frame(&s, t += 0.008, 0, ids, down, xs, ys);
  expect("three-finger tap (80 ms)", 1, "tap", NULL);
}

/**
 * The failure mode that made the first version lose every tap: fingers so quick
 * that the only frame the framework reports already has them lifting. Counting
 * "down" states only would drop this contact entirely.
 */
static void testQuickTapOnlyLiftingFrames(void) {
  GestureState s;
  gestureInit(&s, 3, 450, 0.06, sink, NULL);
  logReset();
  int32_t ids[3] = {4, 5, 6};
  float xs[3] = {0.40f, 0.45f, 0.50f};
  float ys[3] = {0.40f, 0.42f, 0.40f};
  int32_t lift[3] = {5, 5, 5};
  int32_t gone[3] = {7, 7, 7};
  double t = 200.0;
  frame(&s, t, 3, ids, lift, xs, ys);
  frame(&s, t += 0.008, 3, ids, gone, xs, ys);
  frame(&s, t += 0.008, 0, ids, gone, xs, ys);
  expect("tap seen only while lifting", 1, "tap", NULL);
}

/** Fingers landing one after another: no single frame has all three resting. */
static void testStaggeredTap(void) {
  GestureState s;
  gestureInit(&s, 3, 450, 0.06, sink, NULL);
  logReset();
  int32_t ids[3] = {7, 8, 9};
  float xs[3] = {0.40f, 0.45f, 0.50f};
  float ys[3] = {0.40f, 0.42f, 0.40f};
  int32_t one[1] = {1};
  int32_t two[2] = {1, 1};
  int32_t three[3] = {1, 1, 1};
  int32_t lift[3] = {5, 5, 5};
  double t = 300.0;
  frame(&s, t, 1, ids, one, xs, ys);
  frame(&s, t += 0.012, 2, ids, two, xs, ys);
  frame(&s, t += 0.012, 3, ids, three, xs, ys);
  frame(&s, t += 0.012, 3, ids, lift, xs, ys);
  frame(&s, t += 0.008, 0, ids, three, xs, ys);
  expect("tap landing finger by finger", 1, "tap", NULL);
}

/** A hold: press at the threshold, release when the fingers come up. */
static void testHold(void) {
  GestureState s;
  gestureInit(&s, 3, 450, 0.06, sink, NULL);
  logReset();
  int32_t ids[3] = {11, 12, 13};
  float xs[3] = {0.40f, 0.45f, 0.50f};
  float ys[3] = {0.40f, 0.42f, 0.40f};
  int32_t down[3] = {1, 1, 1};
  int32_t rest[3] = {4, 4, 4};
  int32_t lift[3] = {5, 5, 5};
  double t = 400.0;
  frame(&s, t, 3, ids, down, xs, ys);
  for (int i = 0; i < 80; i++) frame(&s, t += 0.008, 3, ids, rest, xs, ys);
  frame(&s, t += 0.008, 3, ids, lift, xs, ys);
  frame(&s, t += 0.008, 0, ids, down, xs, ys);
  expect("hold for 640 ms", 2, "press", "release");
  checks++;
  if (gLog.heldMs[0] < 440 || gLog.heldMs[0] > 470) {
    failures++;
    printf("  FAIL hold press at %.0f ms, expected ~450\n", gLog.heldMs[0]);
  }
}

/** One finger lifted while the others stay: the hold ends there. */
static void testPartialLift(void) {
  GestureState s;
  gestureInit(&s, 3, 450, 0.06, sink, NULL);
  logReset();
  int32_t ids[3] = {21, 22, 23};
  float xs[3] = {0.40f, 0.45f, 0.50f};
  float ys[3] = {0.40f, 0.42f, 0.40f};
  int32_t rest[3] = {4, 4, 4};
  int32_t lift[3] = {4, 4, 5};
  double t = 500.0;
  frame(&s, t, 3, ids, rest, xs, ys);
  for (int i = 0; i < 70; i++) frame(&s, t += 0.008, 3, ids, rest, xs, ys);
  frame(&s, t += 0.008, 3, ids, lift, xs, ys);
  expect("one finger up ends the hold", 2, "press", "release");
}

/** A fourth finger during a hold: Mission Control, not dictation. */
static void testFourthFinger(void) {
  GestureState s;
  gestureInit(&s, 3, 450, 0.06, sink, NULL);
  logReset();
  int32_t ids3[3] = {31, 32, 33};
  float xs3[3] = {0.40f, 0.45f, 0.50f};
  float ys3[3] = {0.40f, 0.42f, 0.40f};
  int32_t rest[3] = {4, 4, 4};
  double t = 600.0;
  frame(&s, t, 3, ids3, rest, xs3, ys3);
  for (int i = 0; i < 70; i++) frame(&s, t += 0.008, 3, ids3, rest, xs3, ys3);
  int32_t ids4[4] = {31, 32, 33, 34};
  float xs4[4] = {0.40f, 0.45f, 0.50f, 0.55f};
  float ys4[4] = {0.40f, 0.42f, 0.40f, 0.42f};
  int32_t rest4[4] = {4, 4, 4, 4};
  frame(&s, t += 0.008, 4, ids4, rest4, xs4, ys4);
  expect("fourth finger cancels recording", 2, "press", "cancel");
}

/** A three-finger swipe (Mission Control) must never open or record. */
static void testSwipe(void) {
  GestureState s;
  gestureInit(&s, 3, 450, 0.06, sink, NULL);
  logReset();
  int32_t ids[3] = {41, 42, 43};
  float xs[3] = {0.40f, 0.45f, 0.50f};
  float ys[3] = {0.40f, 0.42f, 0.40f};
  int32_t rest[3] = {4, 4, 4};
  double t = 700.0;
  frame(&s, t, 3, ids, rest, xs, ys);
  for (int i = 1; i <= 30; i++) {
    float moved[3] = {0.40f + i * 0.01f, 0.45f + i * 0.01f, 0.50f + i * 0.01f};
    frame(&s, t += 0.008, 3, ids, rest, moved, ys);
  }
  int32_t lift[3] = {5, 5, 5};
  frame(&s, t += 0.008, 3, ids, lift, xs, ys);
  frame(&s, t += 0.008, 0, ids, rest, xs, ys);
  expect("swipe is not a tap", 0, NULL, NULL);
}

/** Two fingers are scroll and right-click: never ours. */
static void testTwoFingers(void) {
  GestureState s;
  gestureInit(&s, 3, 450, 0.06, sink, NULL);
  logReset();
  int32_t ids[2] = {51, 52};
  float xs[2] = {0.40f, 0.45f};
  float ys[2] = {0.40f, 0.42f};
  int32_t rest[2] = {4, 4};
  double t = 800.0;
  frame(&s, t, 2, ids, rest, xs, ys);
  frame(&s, t += 0.05, 2, ids, rest, xs, ys);
  frame(&s, t += 0.008, 0, ids, rest, xs, ys);
  expect("two-finger tap is ignored", 0, NULL, NULL);
}

/** Two taps in a row are two taps, not one long contact. */
static void testDoubleTap(void) {
  GestureState s;
  gestureInit(&s, 3, 450, 0.06, sink, NULL);
  logReset();
  int32_t ids[3] = {61, 62, 63};
  float xs[3] = {0.40f, 0.45f, 0.50f};
  float ys[3] = {0.40f, 0.42f, 0.40f};
  int32_t rest[3] = {4, 4, 4};
  int32_t lift[3] = {5, 5, 5};
  double t = 900.0;
  for (int round = 0; round < 2; round++) {
    frame(&s, t, 3, ids, rest, xs, ys);
    frame(&s, t += 0.02, 3, ids, rest, xs, ys);
    frame(&s, t += 0.008, 3, ids, lift, xs, ys);
    frame(&s, t += 0.008, 0, ids, rest, xs, ys);
    t += 0.15;
  }
  expect("two taps in a row", 2, "tap", "tap");
}

/** A hold long enough that the card must not fire a tap on release. */
static void testLongHoldDoesNotTap(void) {
  GestureState s;
  gestureInit(&s, 3, 450, 0.06, sink, NULL);
  logReset();
  int32_t ids[3] = {71, 72, 73};
  float xs[3] = {0.40f, 0.45f, 0.50f};
  float ys[3] = {0.40f, 0.42f, 0.40f};
  int32_t rest[3] = {4, 4, 4};
  double t = 1000.0;
  frame(&s, t, 3, ids, rest, xs, ys);
  for (int i = 0; i < 200; i++) frame(&s, t += 0.008, 3, ids, rest, xs, ys);
  frame(&s, t += 0.008, 0, ids, rest, xs, ys);
  expect("long hold: press + release, no tap", 2, "press", "release");
}

int main(void) {
  printf("gesture classifier\n");
  testTap();
  testQuickTapOnlyLiftingFrames();
  testStaggeredTap();
  testHold();
  testPartialLift();
  testFourthFinger();
  testSwipe();
  testTwoFingers();
  testDoubleTap();
  testLongHoldDoesNotTap();
  printf("\n%d checks, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
