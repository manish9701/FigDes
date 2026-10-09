/**
 * Accessibility evaluator (blueprint §7.4).
 *
 * Accessibility was previously a 0–10 number derived from font size alone,
 * produced by a scorer that had just measured text contrast and then ignored
 * it. This module replaces that with an explicit checklist and — critically —
 * a record of what could **not** be checked.
 *
 * The blueprint is blunt about the limit: *"do not claim full accessibility
 * conformance from screenshot checks alone. Report what was and was not
 * tested."* So `notChecked` is a first-class output, not an afterthought, and
 * this module never reports a conformance verdict — only findings and coverage.
 */
import { makeFinding, type DesignFinding } from "./finding";

/** WCAG AA for normal text. Large text (≥18pt / 24px bold) relaxes to 3:1. */
export const CONTRAST_MIN_NORMAL = 4.5;
export const CONTRAST_MIN_LARGE = 3;
/** WCAG 1.4.11 non-text contrast for UI components and state indicators. */
export const CONTRAST_MIN_NON_TEXT = 3;
/** WCAG 2.5.8 target size, with the AA floor of 2.5.8 respected at 24px. */
export const TARGET_MIN_PX = 24;
export const TARGET_RECOMMENDED_PX = 44;
export const LINE_LENGTH_MAX_CHARS = 95;
export const MIN_BODY_TEXT_PX = 12;

export interface AccessibilityText {
  id: string;
  content?: string;
  /** Rendered font size in px. */
  size?: number;
  /** Characters per rendered line. */
  lineLength?: number;
  /** Measured contrast ratio against its actual background. */
  contrastRatio?: number;
  isBold?: boolean;
  /** True when this text encodes a state the user must notice. */
  encodesState?: boolean;
}

export interface AccessibilityTarget {
  id: string;
  label?: string;
  width: number;
  height: number;
  /** Gap in px to the nearest other interactive target. */
  nearestGap?: number;
}

export interface AccessibilityStateIndicator {
  id: string;
  label: string;
  /** True when colour is the *only* carrier of the state. */
  colorOnly: boolean;
  /** Text, icon or shape that also carries it. */
  hasRedundantCue?: boolean;
}

export interface AccessibilityControl {
  id: string;
  label: string;
  /** True when the control has an accessible name (label, not just an icon). */
  hasAccessibleName: boolean;
  keyboardReachable?: boolean;
}

export interface AccessibilityErrorMessage {
  id: string;
  message: string;
  /** True when the message names the control and what to do. */
  identifiesControlAndFix?: boolean;
}

export type Platform = "web" | "desktop" | "ios" | "android";

export interface AccessibilityInput {
  revisionId: string;
  platform?: Platform;
  texts?: AccessibilityText[];
  /** Non-text elements that must be distinguishable from their background. */
  nonText?: Array<{ id: string; label: string; contrastRatio: number }>;
  stateIndicators?: AccessibilityStateIndicator[];
  targets?: AccessibilityTarget[];
  controls?: AccessibilityControl[];
  errors?: AccessibilityErrorMessage[];
  focusIndicators?: Array<{ id: string; label: string; visible: boolean }>;
  /** Whether the design declares a reduced-motion behaviour. */
  reducedMotion?: { requested: boolean; respected: boolean };
}

export interface AccessibilityReport {
  findings: DesignFinding[];
  checked: string[];
  /** Explicitly not verified — reported, never implied. */
  notChecked: string[];
  summary: string;
}

function ev(revisionId: string, reference: string, details: string) {
  return [{ type: "geometry" as const, revisionId, reference, details }];
}

function isLargeText(text: AccessibilityText): boolean {
  return (text.size ?? 0) >= 24 || (text.isBold === true && (text.size ?? 0) >= 18.66);
}

export function evaluateAccessibility(input: AccessibilityInput): AccessibilityReport {
  const findings: DesignFinding[] = [];
  const checked: string[] = [];
  const notChecked: string[] = [];
  const rev = input.revisionId;

  /* -- Text contrast ------------------------------------------------------- */
  if (!input.texts) {
    notChecked.push("text-contrast: no text measurements supplied");
  } else {
    checked.push("text-contrast");
    for (const text of input.texts) {
      if (typeof text.contrastRatio !== "number") continue;
      const min = isLargeText(text) ? CONTRAST_MIN_LARGE : CONTRAST_MIN_NORMAL;
      if (text.contrastRatio < min) {
        findings.push(
          makeFinding({
            ruleId: "a11y.text-contrast",
            category: "accessibility",
            severity: text.contrastRatio < min - 1.5 ? "high" : "medium",
            confidence: 0.9,
            summary: `Text contrast ${text.contrastRatio.toFixed(2)}:1 below ${min}:1`,
            rationale: `WCAG AA requires ${min}:1 for this text size. Measured ${text.contrastRatio.toFixed(2)}:1, so the content is hard or impossible to read for low-vision users.`,
            evidence: ev(rev, text.id, `contrast=${text.contrastRatio.toFixed(2)} required=${min} size=${text.size ?? "?"}`),
            affectedNodeIds: [text.id],
            suggestedFix: "Move the text to a semantic token with sufficient contrast (foreground/surface pair), not a raw hex value.",
            verification: "Re-measure contrast on the rendered result and confirm it meets the threshold for that size.",
          }),
        );
      }
    }
  }

  /* -- Non-text contrast ---------------------------------------------------- */
  if (!input.nonText) {
    notChecked.push("non-text-contrast: no non-text measurements supplied");
  } else {
    checked.push("non-text-contrast");
    for (const element of input.nonText) {
      if (element.contrastRatio < CONTRAST_MIN_NON_TEXT) {
        findings.push(
          makeFinding({
            ruleId: "a11y.non-text-contrast",
            category: "accessibility",
            severity: "medium",
            confidence: 0.85,
            summary: `Non-text contrast ${element.contrastRatio.toFixed(2)}:1 below ${CONTRAST_MIN_NON_TEXT}:1 for "${element.label}"`,
            rationale: "Control boundaries, focus rings and state indicators need 3:1 against their background to be perceivable without colour perception.",
            evidence: ev(rev, element.id, `contrast=${element.contrastRatio.toFixed(2)} label=${element.label}`),
            affectedNodeIds: [element.id],
            suggestedFix: "Use a semantic border/state token that clears 3:1 against both the surface and the canvas.",
            verification: "Re-measure the boundary against its actual rendered background.",
          }),
        );
      }
    }
  }

  /* -- Legible sizes and line lengths -------------------------------------- */
  if (!input.texts) {
    notChecked.push("text-legibility: no text measurements supplied");
  } else {
    checked.push("text-legibility");
    for (const text of input.texts) {
      if (typeof text.size === "number" && text.size > 0 && text.size < MIN_BODY_TEXT_PX) {
        findings.push(
          makeFinding({
            ruleId: "a11y.text-too-small",
            category: "accessibility",
            severity: "medium",
            confidence: 0.85,
            summary: `Text at ${text.size}px below the ${MIN_BODY_TEXT_PX}px legibility floor`,
            rationale: "Below roughly 12px, dense technical screens become unreadable for many users and unreadable for all users on low-density displays.",
            evidence: ev(rev, text.id, `size=${text.size}px`),
            affectedNodeIds: [text.id],
            suggestedFix: "Move the label up the type scale rather than inventing an off-scale size.",
            verification: "Confirm the rendered font size comes from the type scale.",
          }),
        );
      }
      if (typeof text.lineLength === "number" && text.lineLength > LINE_LENGTH_MAX_CHARS) {
        findings.push(
          makeFinding({
            ruleId: "a11y.line-too-long",
            category: "accessibility",
            severity: "low",
            confidence: 0.7,
            summary: `Line length ${text.lineLength} characters exceeds ${LINE_LENGTH_MAX_CHARS}`,
            rationale: "Long measures make return sweeps error-prone, especially in dense data screens where the reader already scans horizontally.",
            evidence: ev(rev, text.id, `lineLength=${text.lineLength}`),
            affectedNodeIds: [text.id],
            suggestedFix: "Constrain the text region or switch the content to a table/list form.",
            verification: "Confirm the rendered line length is within the comfortable range.",
          }),
        );
      }
    }
  }

  /* -- Colour alone conveying state ----------------------------------------- */
  if (!input.stateIndicators) {
    notChecked.push("colour-only-state: no state indicators supplied");
  } else {
    checked.push("colour-only-state");
    for (const indicator of input.stateIndicators) {
      if (indicator.colorOnly && indicator.hasRedundantCue !== true) {
        findings.push(
          makeFinding({
            ruleId: "a11y.color-only-state",
            category: "accessibility",
            severity: indicator.label === "" ? "medium" : "high",
            confidence: 0.85,
            summary: `State "${indicator.label || "(unnamed)"}" is conveyed by colour alone`,
            rationale: "Roughly 1 in 12 men cannot separate these hues. If the state is also carried by text, icon or shape, it survives; otherwise it does not exist for them.",
            evidence: ev(rev, indicator.id, `label=${indicator.label} colorOnly=true redundantCue=${indicator.hasRedundantCue ?? false}`),
            affectedNodeIds: [indicator.id],
            suggestedFix: "Add a redundant cue — severity text, an icon, or a distinct shape — alongside the colour.",
            verification: "Confirm the state is readable in greyscale.",
          }),
        );
      }
    }
  }

  /* -- Focus / selection visibility ---------------------------------------- */
  if (!input.focusIndicators) {
    notChecked.push("focus-visibility: focus indicators were not measured (requires the interactive prototype, not the static frame)");
  } else {
    checked.push("focus-visibility");
    for (const focus of input.focusIndicators) {
      if (!focus.visible) {
        findings.push(
          makeFinding({
            ruleId: "a11y.focus-invisible",
            category: "accessibility",
            severity: "high",
            confidence: 0.8,
            summary: `No visible focus indicator on "${focus.label}"`,
            rationale: "Keyboard users cannot tell where they are. A focus ring is also the cheapest proof the design intends keyboard operation at all.",
            evidence: ev(rev, focus.id, `label=${focus.label} visible=false`),
            affectedNodeIds: [focus.id],
            suggestedFix: "Define a focus variant on the component with a ring that clears 3:1 non-text contrast.",
            verification: "Tab through the implemented prototype and confirm a visible ring on every interactive element.",
          }),
        );
      }
    }
  }

  /* -- Hit targets ---------------------------------------------------------- */
  if (!input.targets) {
    notChecked.push("target-size: no hit-target geometry supplied");
  } else {
    checked.push("target-size");
    for (const target of input.targets) {
      const smallest = Math.min(target.width, target.height);
      if (smallest < TARGET_MIN_PX) {
        findings.push(
          makeFinding({
            ruleId: "a11y.target-too-small",
            category: "accessibility",
            severity: smallest < TARGET_MIN_PX - 8 ? "high" : "medium",
            confidence: 0.9,
            summary: `Target "${target.label ?? target.id}" is ${Math.round(target.width)}×${Math.round(target.height)}, below ${TARGET_MIN_PX}px`,
            rationale: `WCAG 2.2 requires a ${TARGET_MIN_PX}px minimum target. ${smallest.toFixed(0)}px forces precise aiming and excludes users with motor impairments.`,
            evidence: ev(rev, target.id, `${Math.round(target.width)}x${Math.round(target.height)} min=${TARGET_MIN_PX}`),
            affectedNodeIds: [target.id],
            suggestedFix: `Grow the hit area to at least ${TARGET_RECOMMENDED_PX}px (or ${TARGET_MIN_PX}px minimum) — padding, not a bigger visual box.`,
            verification: "Confirm the interactive bounds in the built prototype.",
          }),
        );
      } else if (smallest < TARGET_RECOMMENDED_PX) {
        findings.push(
          makeFinding({
            ruleId: "a11y.target-under-recommended",
            category: "accessibility",
            severity: "low",
            confidence: 0.7,
            summary: `Target "${target.label ?? target.id}" is ${Math.round(target.width)}×${Math.round(target.height)}, under the ${TARGET_RECOMMENDED_PX}px recommendation`,
            rationale: "It clears the AA minimum but not the comfortable size for a dense control-heavy screen.",
            evidence: ev(rev, target.id, `${Math.round(target.width)}x${Math.round(target.height)}`),
            affectedNodeIds: [target.id],
            suggestedFix: `Consider ${TARGET_RECOMMENDED_PX}px where spacing allows.`,
            verification: "Confirm the interactive bounds in the built prototype.",
          }),
        );
      }
      if (typeof target.nearestGap === "number" && target.nearestGap < 8) {
        findings.push(
          makeFinding({
            ruleId: "a11y.targets-adjacent",
            category: "accessibility",
            severity: "low",
            confidence: 0.65,
            summary: `Only ${target.nearestGap.toFixed(0)}px between targets near "${target.label ?? target.id}"`,
            rationale: "Closely spaced targets are missable, and the spacing exception in WCAG 2.2 is easy to lose track of.",
            evidence: ev(rev, target.id, `nearestGap=${target.nearestGap}`),
            affectedNodeIds: [target.id],
            suggestedFix: "Increase spacing or group related targets under one hit area.",
            verification: "Confirm spacing in the built prototype.",
          }),
        );
      }
    }
  }

  /* -- Labels and control identification ------------------------------------ */
  if (!input.controls) {
    notChecked.push("control-labels: no control inventory supplied");
  } else {
    checked.push("control-labels");
    for (const control of input.controls) {
      if (!control.hasAccessibleName) {
        findings.push(
          makeFinding({
            ruleId: "a11y.unlabelled-control",
            category: "accessibility",
            severity: "high",
            confidence: 0.8,
            summary: `Control "${control.label}" has no accessible name`,
            rationale: "An icon-only or unlabelled control is announced as an unlabelled button by a screen reader, leaving the user with no way to know what it does.",
            evidence: ev(rev, control.id, `label=${control.label} accessibleName=false`),
            affectedNodeIds: [control.id],
            suggestedFix: "Add a visible label, or an accessible name on the component variant.",
            verification: "Confirm the control exposes a name in the accessibility tree.",
          }),
        );
      }
      const platform = input.platform ?? "web";
      if (control.keyboardReachable === false && (platform === "web" || platform === "desktop")) {
        findings.push(
          makeFinding({
            ruleId: "a11y.not-keyboard-reachable",
            category: "accessibility",
            severity: "high",
            confidence: 0.75,
            summary: `Control "${control.label}" is not keyboard reachable on ${platform}`,
            rationale: "Keyboard operation is an expectation, not an enhancement, for web and desktop targets.",
            evidence: ev(rev, control.id, `label=${control.label} platform=${platform} keyboardReachable=false`),
            affectedNodeIds: [control.id],
            suggestedFix: "Make the control focusable and operable with the platform's standard keys.",
            verification: "Tab to the control and operate it with the keyboard in the prototype.",
          }),
        );
      }
    }
  }

  /* -- Error-message clarity ------------------------------------------------ */
  if (!input.errors) {
    notChecked.push("error-clarity: no error states supplied");
  } else {
    checked.push("error-clarity");
    for (const error of input.errors) {
      if (error.message.trim().length === 0) {
        findings.push(
          makeFinding({
            ruleId: "a11y.empty-error-message",
            category: "accessibility",
            severity: "high",
            confidence: 0.85,
            summary: "An error state has no message",
            rationale: "A red panel with no text tells the user something is wrong and nothing about what to do next.",
            evidence: ev(rev, error.id, "empty error message"),
            affectedNodeIds: [error.id],
            suggestedFix: "State what failed, which control caused it, and what to do next.",
            verification: "Confirm the error copy names the cause and the next step.",
          }),
        );
      } else if (error.identifiesControlAndFix !== true) {
        findings.push(
          makeFinding({
            ruleId: "a11y.error-unclear",
            category: "accessibility",
            severity: "medium",
            confidence: 0.65,
            summary: `Error message "${error.message.slice(0, 60)}" does not identify the control or the fix`,
            rationale: "Errors that name neither the offending field nor the next action force the user to guess.",
            evidence: ev(rev, error.id, `message="${error.message.slice(0, 80)}"`),
            affectedNodeIds: [error.id],
            suggestedFix: "Name the field and the corrective action.",
            verification: "Confirm the copy reads as cause + fix.",
          }),
        );
      }
    }
  }

  /* -- Reduced motion ------------------------------------------------------- */
  if (!input.reducedMotion) {
    notChecked.push("reduced-motion: not declared; motion behaviour is unverifiable in a static frame");
  } else if (input.reducedMotion.requested && !input.reducedMotion.respected) {
    checked.push("reduced-motion");
    findings.push(
      makeFinding({
        ruleId: "a11y.reduced-motion-ignored",
        category: "accessibility",
        severity: "medium",
        confidence: 0.75,
        summary: "Reduced-motion preference is not respected",
        rationale: "Motion triggers migraines and vestibular disorders. Declaring a preference and ignoring it is worse than not declaring one.",
        evidence: ev(rev, "reduced-motion", "requested=true respected=false"),
        suggestedFix: "Specify the reduced-motion variant for any animated transition.",
        verification: "Confirm the reduced variant exists as a component variant.",
      }),
    );
  } else {
    checked.push("reduced-motion");
  }

  const critical = findings.filter((f) => f.severity === "critical").length;
  const summary =
    findings.length === 0
      ? `${checked.length} accessibility check(s) passed; ${notChecked.length} could not be verified from a static frame. This is not a conformance claim.`
      : `${findings.length} accessibility finding(s) (${critical} critical); ${notChecked.length} check(s) could not be verified from a static frame. This is not a conformance claim.`;

  return { findings, checked, notChecked, summary };
}
