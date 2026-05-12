export interface AffiliateBrand {
  id: number;
  name: string;
  category: string | null;
  website: string | null;
  affiliate_program_url: string | null;
  contact_name: string | null;
  contact_email: string | null;
  state: string;
  state_changed_at: string;
  state_changed_by: string | null;
  fit_reason: string | null;
  rejection_reason: string | null;
  commission_rate: string | null;
  min_subs_required: number | null;
  current_link_url: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface StateHistoryRow {
  id: number;
  brand_id: number;
  from_state: string | null;
  to_state: string;
  changed_at: string;
  changed_by: string | null;
  trigger_reason: string | null;
  note: string | null;
}

export interface AlertRow {
  id: number;
  source: string;
  severity: "info" | "warning" | "urgent";
  title: string;
  body: string | null;
  related_brand_id: number | null;
  related_upload_id: number | null;
  decision_required: number;
  deadline: string | null;
  status: "open" | "acted" | "dismissed" | "expired";
  created_at: string;
  acted_at: string | null;
  notes: string | null;
}

export interface OutreachDraftRow {
  id: number;
  brand_id: number;
  draft_subject: string;
  draft_body: string;
  status: "pending" | "approved" | "sent" | "rejected" | "edited";
  drafted_at: string;
  reviewed_at: string | null;
  sent_at: string | null;
  edits_made: string | null;
  notes: string | null;
}

export const getBrand = (db: D1Database, id: number) =>
  db.prepare("SELECT * FROM affiliate_brands WHERE id = ?").bind(id).first<AffiliateBrand>();
