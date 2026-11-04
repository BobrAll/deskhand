// Trackpad gesture classification: three fingers, one tap or one hold.
//
// Kept apart from `helper.m` so it can be replayed against recorded contact
// frames (`scripts/gesture-replay.m`): the hard part of this feature is not
// reading the trackpad, it is deciding when a contact is a tap and when it is a
// hold, and that decision is worth testing without a hand on the pad.
//
// The caller feeds whole frames — the touches of one 8 ms callback — and gets
// gesture edges back through a sink. Nothing here knows about JSON, processes or
// the framework.

#ifndef SMARTCURSOR_GESTURE_H
#define SMARTCURSOR_GESTURE_H

#include <math.h>
#include <stdint.h>
#include <string.h>

// The contact record is ABI, not a documented struct: this is the layout every
// version of the framework since 10.6 has used, and only the fields below are
// read.
typedef struct {
  float x, y;
} MTPoint;

typedef struct {
  MTPoint pos, vel;
} MTVector;

typedef struct {
  int32_t frame;
  double timestamp;
  int32_t identifier;
  int32_t state;
  int32_t fingerId;
  int32_t handId;
  MTVector normalized;
  float size;
  int32_t zero1;
  float angle;
  float majorAxis;
  float minorAxis;
  MTVector absolute;
  int32_t zero2[2];
  float zDensity;
} MTTouch;

typedef enum {
  kGestureEventNone = 0,
  kGestureEventTap,
  kGestureEventPress,
  kGestureEventRelease,
  kGestureEventCancel
} GestureEventKind;

/**
 * Receives one edge. `heldMs` is how long the contact had lasted when the edge
 * was produced, in milliseconds; the caller may log it or ignore it.
 */
typedef void (*GestureSink)(GestureEventKind kind, double heldMs, void *context);

/**
 * Contact states, as the framework reports them: 1 = finger down, 2/3 = the
 * moment it settles, 4 = touching, 5 = lifting, 6/7 = gone.
 *
 * A finger is "present" from the moment it lands until it has fully left (1..5):
 * a very quick tap may never show state 4, and a frame that only holds lifting
 * fingers still proves the contact happened. Only 1..4 count as "resting", which
 * is what a hold is measured against — otherwise the moment of lifting would
 * keep extending the hold.
 */
static inline int gestureIsPresent(int32_t state) {
  return state >= 1 && state <= 5;
}

static inline int gestureIsResting(int32_t state) {
  return state >= 1 && state <= 4;
}

#define GESTURE_MAX_FINGERS 8

typedef struct {
  int fingers;
  double holdSeconds;
  /** How far a finger may drift, in trackpad units, before it is a swipe. */
  double moveTolerance;
} GestureConfig;

typedef struct {
  int active;
  double startedAt;
  int32_t ids[GESTURE_MAX_FINGERS];
  MTPoint startPos[GESTURE_MAX_FINGERS];
  int idCount;
  /** Set once any finger drifts further than the tolerance: a swipe, not a tap. */
  int moved;
  /** `press` was emitted for this contact; the matching `release` is pending. */
  int holding;
  /** `tap`, `press` or `cancel` was already reported: ignore until all lift. */
  int consumed;
  /** Began with more fingers than asked for (Mission Control, a palm). */
  int rejected;
  /** Most fingers present at once, in any state including lifting. */
  int maxPresent;
} GestureSession;

typedef struct {
  GestureConfig config;
  GestureSession session;
  GestureSink sink;
  void *context;
} GestureState;

static inline void gestureInit(GestureState *state, int fingers, double holdMs,
                               double moveTolerance, GestureSink sink, void *context) {
  memset(state, 0, sizeof(*state));
  state->config.fingers = fingers;
  state->config.holdSeconds = holdMs / 1000.0;
  state->config.moveTolerance = moveTolerance;
  state->sink = sink;
  state->context = context;
}

static inline void gestureEmit(GestureState *state, GestureEventKind kind, double heldMs) {
  if (state->sink) state->sink(kind, heldMs, state->context);
}

/** Adds a finger to the contact, remembering where it landed. */
static inline void gestureRemember(GestureState *state, int32_t identifier, MTPoint position) {
  GestureSession *s = &state->session;
  if (s->idCount >= GESTURE_MAX_FINGERS) return;
  for (int i = 0; i < s->idCount; i++) {
    if (s->ids[i] == identifier) return;
  }
  s->ids[s->idCount] = identifier;
  s->startPos[s->idCount] = position;
  s->idCount++;
}

/** Flags the contact as a swipe once a resting finger moved past the tolerance. */
static inline void gestureCheckMovement(GestureState *state, const MTTouch *touches, int count) {
  GestureSession *s = &state->session;
  if (s->moved) return;
  for (int i = 0; i < count; i++) {
    if (!gestureIsResting(touches[i].state)) continue;
    for (int j = 0; j < s->idCount; j++) {
      if (s->ids[j] != touches[i].identifier) continue;
      double dx = (double)touches[i].normalized.pos.x - (double)s->startPos[j].x;
      double dy = (double)touches[i].normalized.pos.y - (double)s->startPos[j].y;
      if (sqrt(dx * dx + dy * dy) > state->config.moveTolerance) {
        s->moved = 1;
        return;
      }
      break;
    }
  }
}

/**
 * Classifies one contact frame and reports whatever edge it completes.
 *
 * The rules, in one place:
 *
 *   contact ends, no hold was started  -> `tap`   (three fingers were there)
 *   contact ends after a hold          -> `release`
 *   fingers rest past `holdSeconds`    -> `press` (once per contact)
 *   a fourth finger, or a swipe        -> `cancel` if recording, else silence
 *
 * The tap is decided when the contact *ends*, never per frame: a quick tap is
 * often too fast for all three fingers to share one 8 ms frame, so a per-frame
 * finger count loses it. `maxPresent` keeps the largest count seen, which is what
 * a tap is measured against.
 */
static inline void gestureHandleFrame(GestureState *state, const MTTouch *touches, int count,
                                      double now) {
  GestureSession *s = &state->session;
  int present = 0;
  int resting = 0;
  for (int i = 0; i < count; i++) {
    if (gestureIsPresent(touches[i].state)) present++;
    if (gestureIsResting(touches[i].state)) resting++;
  }

  if (present == 0) {
    // The contact is over: everything the user did with those fingers is known.
    if (s->active) {
      double held = (now - s->startedAt) * 1000.0;
      if (s->holding) {
        // All fingers lifted at once after a hold: that is the release of the
        // recording, not a second gesture.
        gestureEmit(state, kGestureEventRelease, held);
      } else if (!s->consumed && !s->rejected && !s->moved &&
                 s->maxPresent >= state->config.fingers &&
                 s->idCount >= state->config.fingers) {
        gestureEmit(state, kGestureEventTap, held);
      }
    }
    memset(s, 0, sizeof(*s));
    return;
  }

  if (!s->active) {
    s->active = 1;
    s->startedAt = now;
    s->maxPresent = present;
    // A contact that begins with more fingers than asked for belongs to someone
    // else: Mission Control, an app switch, a palm resting on the pad.
    s->rejected = present > state->config.fingers;
  }
  if (present > s->maxPresent) s->maxPresent = present;

  // Every finger seen during the contact is remembered, including one already
  // lifting: a tap may never show three fingers resting at the same moment.
  for (int i = 0; i < count; i++) {
    if (gestureIsPresent(touches[i].state)) {
      gestureRemember(state, touches[i].identifier, touches[i].normalized.pos);
    }
  }

  if (s->consumed) return;

  if (s->rejected || present > state->config.fingers) {
    s->rejected = 1;
    if (s->holding) {
      // Recording stops the moment the gesture stops being ours.
      s->holding = 0;
      s->consumed = 1;
      gestureEmit(state, kGestureEventCancel, (now - s->startedAt) * 1000.0);
    }
    return;
  }

  gestureCheckMovement(state, touches, count);
  if (s->moved) {
    if (s->holding) {
      // A swipe while recording: the user is navigating, not talking.
      s->holding = 0;
      s->consumed = 1;
      gestureEmit(state, kGestureEventCancel, (now - s->startedAt) * 1000.0);
    }
    return;
  }

  // The hold is timed against frames rather than a timer: while fingers rest on
  // the pad the framework reports contacts every ~8 ms, so the deadline is
  // simply noticed on a later frame. A timer would need a run loop of its own.
  if (!s->holding && resting >= state->config.fingers && s->idCount >= state->config.fingers &&
      now - s->startedAt >= state->config.holdSeconds) {
    s->holding = 1;
    gestureEmit(state, kGestureEventPress, (now - s->startedAt) * 1000.0);
    return;
  }

  // Lifting one finger while the others stay down ends the hold too: hold-to-talk
  // stops when the user stops holding, not when the last finger leaves the pad.
  if (s->holding && resting < state->config.fingers) {
    s->holding = 0;
    s->consumed = 1;
    gestureEmit(state, kGestureEventRelease, (now - s->startedAt) * 1000.0);
  }
}

#endif
