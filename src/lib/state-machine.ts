export const STATES = [
  "DISCOVERED",
  "CONSIDERED-REJECTED",
  "OUTREACH-DRAFTED",
  "OUTREACH-SENT",
  "APPLIED",
  "ACCEPTED",
  "ACTIVE",
  "GRADUATING",
  "SPONSOR",
  "DORMANT",
  "CLOSED",
] as const;

export type AffiliateState = typeof STATES[number];

export const isValidState = (s: string): s is AffiliateState =>
  (STATES as readonly string[]).includes(s);

const TRANSITIONS: Record<AffiliateState, AffiliateState[]> = {
  "DISCOVERED": ["CONSIDERED-REJECTED", "OUTREACH-DRAFTED"],
  "CONSIDERED-REJECTED": [],
  "OUTREACH-DRAFTED": ["OUTREACH-SENT", "DISCOVERED"],
  "OUTREACH-SENT": ["APPLIED", "CONSIDERED-REJECTED"],
  "APPLIED": ["ACCEPTED", "CONSIDERED-REJECTED"],
  "ACCEPTED": ["ACTIVE", "CONSIDERED-REJECTED"],
  "ACTIVE": ["GRADUATING", "DORMANT", "CLOSED"],
  "GRADUATING": ["SPONSOR", "ACTIVE"],
  "SPONSOR": ["ACTIVE", "CLOSED"],
  "DORMANT": ["ACTIVE", "CLOSED"],
  "CLOSED": [],
};

export const canTransition = (from: AffiliateState, to: AffiliateState): boolean => {
  if (from === to) return false;
  // Manual override: any non-CLOSED state can move to CLOSED
  if (to === "CLOSED" && from !== "CLOSED") return true;
  return TRANSITIONS[from].includes(to);
};

export interface StallRule {
  days: number;
  title: string;
  body: string;
}

export const STALL_RULES: Partial<Record<AffiliateState, StallRule>> = {
  "DISCOVERED":       { days: 14,  title: "Decide on this brand",          body: "No movement for 14+ days. Decide: outreach, reject, or note." },
  "OUTREACH-DRAFTED": { days: 7,   title: "Review queued draft",           body: "Draft has been pending review for 7+ days." },
  "OUTREACH-SENT":    { days: 14,  title: "Auto-draft follow-up or close", body: "No reply for 14+ days." },
  "APPLIED":          { days: 21,  title: "Escalate or close",             body: "No response on application for 21+ days." },
  "ACCEPTED":         { days: 30,  title: "Stalled acceptance",            body: "Accepted but no gear/content for 30+ days." },
  "ACTIVE":           { days: 90,  title: "Performance review",            body: "No clicks/conversions for 90+ days." },
  "DORMANT":          { days: 180, title: "Archive recommendation",        body: "Dormant for 180+ days. Consider closing." },
};
