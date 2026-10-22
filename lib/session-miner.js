/**
 * Heuristic (LLM-free) miner that extracts work-habit / style candidates from
 * session messages. Precision beats recall here: only high-signal user lines
 * become candidates, and everything lands in the review inbox unless it is an
 * explicit directive. @module dsh-weknora-archive/session-miner
 */

import { captureProfileEntry } from './work-profile.js';

/**
 * One pattern per behavioral signal. Each hit yields
 * `{ kind, content, explicit }`; `explicit` patterns are user directives on
 * record and auto-activate, the rest stay candidates for review.
 */
const SIGNAL_PATTERNS = [
  // Durable directives: "以后/一律/下次都/别再…" — the user set a rule.
  { re: /(以后[^。\n]{4,80}|今后[^。\n]{4,80}|一律[^。\n]{2,80}|下次(?:也|都|请)[^。\n]{2,80}|别再[^。\n]{2,80}|不要再[^。\n]{2,80})/g,
    kind: 'preference', explicit: true },
  // Stated personal preferences.
  { re: /(我(?:习惯|喜欢|偏好|不喜欢|讨厌|拒绝)[^。\n]{2,80})/g, kind: 'preference', explicit: true },
  // Style directives about deliverables/communication.
  { re: /((?:回答|回复|代码|注释|文档|提交信息|commit|命名)[^。\n]{0,10}(?:要|必须|尽量|别|不要)[^。\n]{2,70})/g,
    kind: 'style', explicit: false },
  // Environment facts the user states ("端口改 3337" / "只用 127.0.0.1" …).
  { re: /((?:端口|port)[=:：\s]*\d{2,5}[^。\n]{0,40})/gi, kind: 'env-fact', explicit: false },
  { re: /(只?绑?(?:定)?127\.0\.0\.1[^。\n]{0,30})/g, kind: 'env-fact', explicit: false },
  // Corrections of the agent — strong style/accuracy signals.
  { re: /((?:不是这样的|其实(?:是|不是)|应该是|你理解错了|纠正[：:])[^。\n]{2,80})/g, kind: 'style', explicit: false },
  // "记住/记一下 X" — the user asks for persistence explicitly.
  { re: /(记[一]?[下个][：:][^。\n]{2,90})/g, kind: 'preference', explicit: true },
];

const CLIP = 120;

/**
 * Mine one session's user messages into profile candidates.
 * @param session - { sessionId, messages: [{role, text}] }
 * @returns Array<{ kind, content, evidence, explicit }>
 */
export function mineProfileCandidates(session) {
  const found = [];
  const seen = new Set();
  for (const message of session.messages ?? []) {
    if (message.role !== 'user') continue;
    for (const line of message.text.split(/\n+/)) {
      const trimmed = line.trim();
      if (trimmed.length < 6 || trimmed.length > 300) continue;
      if (/^[<[#`>|]/.test(trimmed)) continue;           // markdown/system noise
      if (/^(?:Current runtime|Time sampled|The user )/.test(trimmed)) continue;
      for (const signal of SIGNAL_PATTERNS) {
        signal.re.lastIndex = 0;
        for (const match of trimmed.matchAll(signal.re)) {
          const content = match[1].replace(/\s+/g, ' ').trim().slice(0, CLIP);
          const key = content.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          found.push({
            kind: signal.kind,
            content,
            evidence: session.sessionId ?? '',
            explicit: signal.explicit,
          });
          if (found.length >= 20) return found;           // cap per session
        }
      }
    }
  }
  return found;
}

/**
 * Mine several sessions into the store (dedupe happens in captureProfileEntry).
 * @returns {{ captured: number, activated: number, candidates: number }}
 */
export function mineSessionsIntoProfile(store, sessions, { source = 'session-mined' } = {}) {
  let captured = 0;
  let activated = 0;
  let candidates = 0;
  for (const session of sessions) {
    for (const candidate of mineProfileCandidates(session)) {
      const { entry, action } = captureProfileEntry(store, {
        kind: candidate.kind,
        content: candidate.content,
        evidence: candidate.evidence,
        source,
        explicit: candidate.explicit,
      });
      if (action === 'duplicate') continue;
      captured++;
      if (entry.status === 'active') activated++; else candidates++;
    }
  }
  return { captured, activated, candidates };
}
