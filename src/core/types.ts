// Shared data model. Everything the extension stores (IndexedDB) is described here.

export type FieldType =
  | 'text' | 'longText' | 'email' | 'phone' | 'url' | 'number' | 'date' | 'checkbox'
  | 'singleSelect' | 'multiSelect' | 'formula' | 'createdTime' | 'lastModified' | 'attachment'
  | 'scrapingStatus' | 'emailStatus' | 'publicationStatus';

export interface Choice { id: string; name: string; color?: string }

/** What a lookup field outputs from a publication result. */
export type LookupOutput = 'title' | 'year' | 'date' | 'doi' | 'url' | 'authors' | 'venue' | 'abstract' | 'fullTextUrl' | 'access' | 'keywords' | 'pdf';

export interface LookupConfig {
  /** 'search' queries a source; 'derive' reads a property of the upstream field's stored result; 'pdf' finds a lawful full text; 'keywords' derives from title/abstract. */
  kind: 'search' | 'derive' | 'pdf' | 'abstract' | 'keywords';
  /** search: the sources to try, in order (first reliable answer wins). */
  sources?: SourceId[];
  /** search: field ids whose values identify the person. */
  nameFieldId?: string;
  institutionFieldId?: string;
  profileUrlFieldId?: string;
  keywordsFieldId?: string;
  /** search filters */
  yearFrom?: number; yearTo?: number; mustContain?: string;
  /** derive / pdf / abstract / keywords: the upstream (search) field this one reads. */
  fromFieldId?: string;
  output: LookupOutput;
  /** extra upstream fields that must be non-empty before this one runs */
  dependsOn?: string[];
}

export interface Field {
  id: string; tableId: string; name: string; type: FieldType; order: number; hidden?: boolean; width?: number; primary?: boolean;
  /** what the field MEANS (email, fullName, latestPublication …) – scraping, e-mail and research find fields by this, in any base */
  key?: string;
  description?: string;
  options?: { choices?: Choice[]; formula?: string; precision?: number };
  lookup?: LookupConfig;
}

export interface AttachmentFile {
  id: string;                 // key in the files store ('' when only a link is known)
  name: string; size: number; mime: string;
  title?: string; year?: number; venue?: string; doi?: string;
  sourceUrl?: string;         // where it came from
  access?: string;            // 'open access (gold)', 'repository', 'user provided', …
  addedAt: string;
}
export interface AttachmentValue { files: AttachmentFile[]; unavailable?: string }

export type CellValue = string | number | boolean | string[] | AttachmentValue | null | undefined;

/** Everything a publication lookup found; kept next to the record so derived fields never need the network. */
export interface Publication {
  title: string; year?: number; date?: string; doi?: string; url?: string; authors: string[]; venue?: string; abstract?: string;
  fullTextUrl?: string; pdfUrl?: string; access?: string; keywords?: string[]; source: SourceId | 'manual'; sourceId?: string;
  authorMatch?: { name: string; id?: string; institution?: string; confidence: number; reasons: string[] };
}
export interface MatchCandidate { id: string; name: string; institution?: string; worksCount?: number; topics?: string[]; orcid?: string; confidence: number; reasons: string[]; source: SourceId; url?: string; /** publication-based sources (Crossref, PubMed, Scholar) offer the work itself as the candidate */ publication?: Publication }

export interface RecordMeta {
  publications?: Record<string, Publication>;                       // by lookup field id
  pending?: Record<string, { candidates: MatchCandidate[]; at: string }>;   // ambiguous author matches waiting for the user
  lookupErrors?: Record<string, string>;
  scrape?: { configId?: string; at: string; fieldsFound: string[]; status: 'ok' | 'partial' | 'failed'; error?: string; publicationLinks?: string[]; identifiers?: string[] };
  emails?: string[];                                                // ids of emailLog rows
  /** which automation (and chain) wrote the last change – used to stop loops */
  origin?: { automationId: string; chain: string[]; depth: number };
  /** when auto-research last tried this record (so a person who cannot be found is not retried every minute) */
  autoTried?: { at: string; outcome: 'found' | 'none' | 'needsMatch' | 'error' };
}

export interface RecordRow {
  id: string; tableId: string; cells: Record<string, CellValue>;
  createdAt: string; updatedAt: string; sourceUrl?: string; meta?: RecordMeta;
}

export type Op = 'is' | 'isNot' | 'contains' | 'notContains' | 'isEmpty' | 'isNotEmpty' | 'gt' | 'lt' | 'gte' | 'lte' | 'before' | 'after' | 'isTrue' | 'isFalse';
export interface Condition { kind: 'condition'; fieldId: string; op: Op; value?: string | number | boolean }
export interface ConditionGroup { kind: 'group'; match: 'and' | 'or'; not?: boolean; items: (Condition | ConditionGroup)[] }

export interface SortSpec { fieldId: string; dir: 'asc' | 'desc' }
export interface View { id: string; tableId: string; name: string; filter: ConditionGroup; sort: SortSpec[]; hiddenFieldIds: string[]; order: number; builtin?: boolean; search?: string }

/** A "base" in the UI. `template` only records where it started; nothing depends on it. */
export interface Table { id: string; databaseId: string; name: string; order: number; template?: string; /** fill missing publication data automatically for records that have a name */ autoResearch?: boolean }
export interface Database { id: string; workspaceId: string; name: string; order: number }
export interface Workspace { id: string; name: string }

// ------------------------------------------------------------------ scraping
export type SourceId = 'openalex' | 'crossref' | 'semanticscholar' | 'pubmed' | 'googlescholar' | 'researchgate' | 'repository' | 'publisher';

export interface FieldMapping {
  fieldId: string;
  /** css selector (or xpath: prefix "xpath:") – relative to the card (list) or the document (profile) */
  selector: string;
  extract: 'text' | 'html' | 'attr' | 'href' | 'email' | 'phone';
  attr?: string; multiple?: boolean; join?: string; regex?: string;
  /** read from the directory card ('card') or the individual profile page ('profile') */
  from: 'card' | 'profile';
}

export interface PaginationConfig {
  mode: 'auto' | 'next' | 'numbered' | 'url' | 'loadMore' | 'infinite' | 'none';
  nextSelector?: string; loadMoreSelector?: string;
  /** url mode: template with {page}, first page number and step */
  urlTemplate?: string; startPage?: number;
  maxPages: number; maxRecords: number; maxScrollRounds: number; delayMinMs: number; delayMaxMs: number;
  stopAfterEmptyPages: number;
  /** when the tab is on a later page of the list, open the first page before reading (default: yes) */
  startFromFirst?: boolean;
}

export interface MapsConfig {
  /** open a place's own page (full address, phone, hours, plus code) in a background tab: only when the list card lacks a phone or address, always, or never */
  details: 'missing' | 'always' | 'never';
  /** visit each business's own website (and its contact page) for an e-mail address, WhatsApp number and social links */
  websiteEmails: boolean;
  /** more searches to run after the one on screen, one per query (e.g. the same service in other cities) */
  queries?: string[];
}

export interface ScrapeConfig {
  id: string; name: string; urlPattern?: string;
  targetTableId?: string;
  /** `kind`: 'people' needs entries whose text looks like a person's name; 'items' accepts any repeated entries (companies, products, leads …) */
  list: { cardSelector?: string; linkSelector?: string; auto: boolean; kind?: 'people' | 'items' };
  mappings: FieldMapping[];
  autoDetect: { email: boolean; phone: boolean; name: boolean; position: boolean; institution: boolean; biography: boolean };
  visitProfiles: boolean; returnToDirectory: boolean; renderJsProfiles: boolean;
  defaults?: Record<string, string>;              // field id → constant (e.g. Institution for this site)
  /** Google Maps result lists (read from the tab the user opened – no API): how much to open, and whether to look for e-mail on each business's own website */
  maps?: MapsConfig;
  pagination: PaginationConfig;
  builtin?: boolean; createdAt: string;
}

export interface ScrapeProgress {
  running: boolean; paused: boolean; phase: string; page: number; found: number; saved: number; skipped: number; errors: string[];
  startedAt: number; updatedAt: number; configId?: string; stopReason?: string; url?: string;
}

/** What the content script sends for every researcher it read. */
export interface ScrapedPerson {
  sourceUrl: string; profileUrl: string; values: Record<string, string>;      // keyed by field id
  fieldsFound: string[]; status: 'ok' | 'partial' | 'failed'; error?: string;
  /** every "Label: value" / table row on the page – filled into any field whose NAME equals the label (so new fields need no configuration) */
  pairs?: [string, string][];
  /** links to publication lists / ORCID / Scholar / ResearchGate found on the profile (identity evidence, never guessed) */
  publicationLinks?: string[]; identifiers?: string[];
}

// ------------------------------------------------------------------ automation
export type TriggerType = 'recordCreated' | 'recordUpdated' | 'fieldBecomesNonEmpty' | 'fieldBecomesEmpty' | 'fieldChanges' | 'recordEntersView' | 'scrapingCompleted' | 'publicationFound' | 'scheduled' | 'manual';
export interface Trigger { type: TriggerType; fieldId?: string; viewId?: string; everyMinutes?: number }

export type ActionType = 'sendEmail' | 'updateField' | 'createRecord' | 'runLookup' | 'downloadPdf' | 'updatePublication' | 'changeStatus' | 'wait' | 'runAutomation';
export interface Action {
  id: string; type: ActionType;
  fieldId?: string;                      // updateField / changeStatus / downloadPdf / runLookup (single)
  value?: string;                        // updateField: template or =formula
  templateId?: string; providerId?: 'brevo' | 'gmail'; senderEmail?: string; toFieldId?: string; statusFieldId?: string; markStatus?: string;
  seconds?: number; automationId?: string;
  tableId?: string; cells?: Record<string, string>;
}
export interface Automation {
  id: string; tableId: string; name: string; enabled: boolean; trigger: Trigger; conditions: ConditionGroup; actions: Action[];
  testMode: boolean; createdAt: string; updatedAt: string; lastRunAt?: string; runCount?: number; maxPerRun?: number;
}
export interface RunStep { actionId: string; type: ActionType; status: 'ok' | 'skipped' | 'error' | 'test'; message: string; at: string }
export interface AutomationRun {
  id: string; automationId: string; automationName: string; recordId?: string; tableId: string; at: string; status: 'ok' | 'error' | 'skipped' | 'test' | 'waiting';
  trigger: string; steps: RunStep[]; error?: string; chain: string[]; depth: number; retryOf?: string;
}

// ------------------------------------------------------------------ e-mail
export interface EmailTemplate { id: string; name: string; subject: string; body: string; createdAt: string; updatedAt: string }
export type EmailEventType = 'sent' | 'delivered' | 'opened' | 'clicked' | 'bounced' | 'unsubscribed' | 'spam' | 'blocked' | 'failed';
export interface EmailLog {
  id: string; recordId: string; tableId: string; to: string; subject: string; provider: 'brevo' | 'gmail' | 'test'; from: string;
  messageId?: string; sentAt: string; status: EmailEventType | 'test'; templateId?: string; automationId?: string;
  events: { type: EmailEventType; at: string }[]; opened?: boolean; clicked?: boolean; bounced?: boolean; unsubscribed?: boolean;
}

export interface PendingJob { id: string; runAt: number; kind: 'continueRun'; payload: { automationId: string; recordId: string; fromActionIndex: number; chain: string[]; depth: number; trigger: string; testMode: boolean }; }
