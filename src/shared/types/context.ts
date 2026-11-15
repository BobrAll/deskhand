export interface ActiveAppInfo {
  bundleId: string
  name: string
  pid: number
  windowTitle: string | null
  windowId: number | null
  bounds: { x: number; y: number; width: number; height: number } | null
}

export interface SelectionInfo {
  text: string
  truncated: boolean
}

/** A rectangle in global screen points (top-left origin), as Electron reports it. */
export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

/** A point in normalised image coordinates: `0..1`, origin at the top-left. */
export interface Point01 {
  x: number
  y: number
}

/**
 * The shapes the assistant may draw over the screen. Everything is expressed in
 * normalised image coordinates, never in pixels — that is what keeps annotations
 * correct on Retina displays and after the screenshot was downscaled.
 */
export type AnnotationKind = 'circle' | 'box' | 'arrow' | 'underline'

export interface Annotation {
  kind: AnnotationKind
  /**
   * One corner of the shape's box, or the tail of an arrow, or the start of an
   * underline.
   *
   * A circle is drawn from the same two corners as a box — it is an ellipse
   * inscribed in them, not a centre plus a radius — which is why a grounded
   * circle is the rectangle of the element it encircles.
   */
  from: Point01
  /** The opposite corner, the arrow head, or the end of the underline. */
  to: Point01
  /** Short caption drawn next to the shape. */
  label?: string
}

/** An annotation that already has an id, so the renderer can animate it in once. */
export interface DrawingShape extends Annotation {
  id: string
}

/** What the transparent drawing layer renders. */
export interface DrawingPayload {
  /** Layer size in points; shapes are scaled to it, not to the capture. */
  width: number
  height: number
  /** Bumped whenever the layer is shown again, so animations replay. */
  revision: number
  /** `false` drives the fade-out before the window is hidden. */
  visible: boolean
  shapes: DrawingShape[]
}

/**
 * One element as the Accessibility API describes it.
 *
 * This is the answer to "where is it, really". The model returns a point in the
 * picture and a language model's point is routinely twenty to sixty points off —
 * enough to hit the neighbour of a 24-point toolbar icon. macOS knows the actual
 * rectangle of every button, so the click is aimed at its centre instead of at
 * the model's guess, and the guess is only used to decide *which* rectangle.
 *
 * Frames are in global screen points with the top-left origin — the same space
 * as `ScreenshotInfo.area`, Electron's `screen` module and the helper's clicks.
 */
export interface AxElementInfo {
  role: string
  subrole?: string
  /** Visible text of the element (a button caption, a menu item's name). */
  title?: string
  /** Current value of a control; for text fields this is the text inside. */
  value?: string
  /** Accessibility label, which is how an icon-only button names itself. */
  description?: string
  /** Tooltip or help exposed by Accessibility. */
  help?: string
  /** Localised role name ("кнопка", "поле ввода") — for humans, not matching. */
  roleDescription?: string
  frame?: ScreenRect | null
  /** The element advertises `AXPress`: clicking it is what it is for. */
  pressable?: boolean
  /** A text input: clicking it focuses it, and typing then lands here. */
  editable?: boolean
  /** How deep the element was found; used only for diagnostics. */
  depth?: number
  /** Owning process, so an element of our own overlay can be ignored. */
  pid?: number
  actions?: string[]
}

/**
 * What the Accessibility API reported for one look at the screen.
 *
 * `targets` is the flat list of everything actionable in the focused window and
 * the menu bar — what the outline offers the model to aim at.
 */
export interface AxProbe {
  pid: number
  targets: AxElementInfo[]
  elapsedMs: number
}

export interface ScreenshotInfo {
  /** data:image/jpeg;base64,... — used for the preview and the request. */
  dataUrl: string
  width: number
  height: number
  bytes: number
  /** Epoch ms of the capture, so the overlay can show how old the image is. */
  capturedAt: number
  /**
   * The screen rectangle the image covers, in global points. Annotations are
   * normalised against the *image*, so mapping them back onto the screen is a
   * plain scale between this rectangle and `width`/`height`.
   */
  area: ScreenRect | null
  /** True when the image is of a whole display rather than of one window. */
  fullScreen: boolean
}

export interface ContextSnapshot {
  activeApp: ActiveAppInfo | null
  selection: SelectionInfo | null
  screenshot: ScreenshotInfo | null
  /** Screenshot still being captured when the overlay is already visible. */
  screenshotPending: boolean
  excluded: boolean
  warnings: string[]
  collectedMs: number
}

export type SystemPermissionRequest = 'accessibility' | 'screenRecording'

export interface PermissionState {
  accessibility: boolean
  screenRecording: boolean
  /** Push-to-talk records the microphone; without it the card only types. */
  microphone: boolean
}
