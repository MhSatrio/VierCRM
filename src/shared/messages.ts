// Messages between the side panel / app pages, the background service worker and the content script.
import type { ScrapeConfig, ScrapeProgress, ScrapedPerson } from '../core/types';
import type { Extracted } from '../scrape/extract';
import type { PageResult, PageState } from '../scrape/pageCrawler';
import type { PickResult } from '../scrape/selector';

/** page/app → background */
export type BgRequest =
  | { type: 'scrape:start'; tabId: number; config: ScrapeConfig; tableId: string }
  | { type: 'scrape:pause' } | { type: 'scrape:resume' } | { type: 'scrape:stop' } | { type: 'scrape:status' }
  | { type: 'scrape:preview'; tabId: number; config: ScrapeConfig }
  | { type: 'picker:start'; tabId: number } | { type: 'picker:stop'; tabId: number }
  | { type: 'record:changed'; change: any }
  | { type: 'lookup:run'; recordId: string; fieldIds?: string[]; force?: boolean; choice?: { fieldId: string; candidate: any } }
  | { type: 'lookup:many'; recordIds: string[]; fieldIds?: string[]; force?: boolean }
  | { type: 'auto:now'; tableId?: string }
  | { type: 'auto:records'; tableId: string; recordIds: string[] }
  | { type: 'auto:run'; automationId: string; recordIds: string[]; testMode?: boolean }
  | { type: 'auto:retry'; runId: string }
  | { type: 'email:send'; recordId: string; templateId: string; providerId?: 'brevo' | 'gmail'; senderEmail?: string; testMode?: boolean; toOverride?: string }
  | { type: 'email:sync' } | { type: 'email:verifyBrevo'; sender: string } | { type: 'gmail:connect' }
  | { type: 'author:search'; name: string; institution?: string; sources: string[]; yearFrom?: number; yearTo?: number; mustContain?: string }
  | { type: 'author:latest'; candidate: any; yearFrom?: number; yearTo?: number; mustContain?: string }
  | { type: 'ping' };

/** background → content script */
export type TabRequest =
  | { type: 'crawl:page'; config: ScrapeConfig; state: PageState }
  | { type: 'crawl:extractHere'; config: ScrapeConfig }
  | { type: 'detect:preview'; config: ScrapeConfig }
  | { type: 'detect:first' }
  | { type: 'picker:start' } | { type: 'picker:stop' }
  | { type: 'widget:progress'; progress: ScrapeProgress };

/** content script → background */
export type ContentRequest =
  | { type: 'scrape:person'; person: ScrapedPerson }
  | { type: 'scrape:render'; url: string; config: ScrapeConfig }
  | { type: 'scrape:control' }
  | { type: 'scrape:site'; url: string }
  | { type: 'scrape:progress-lite'; patch: Partial<ScrapeProgress> & { phase: string } }
  | { type: 'picker:result'; result: PickResult }
  | { type: 'widget:action'; action: 'pause' | 'resume' | 'stop' };

export type { Extracted, PageResult, PageState };
export const isOk = <T extends { ok?: boolean }>(r: T | undefined): r is T => !!r && r.ok !== false;
