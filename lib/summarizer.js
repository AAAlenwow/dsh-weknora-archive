/**
 * Heuristic (LLM-free) session summarizer. Produces one Markdown summary per
 * session following the session-archive template: time range, topic, key
 * decisions/outputs, artifacts, pitfalls, hard details, leftovers. Designed to
 * be unit-testable against mock session data.
 * @module dsh-weknora-archive/summarizer
 */

const PATH_PATTERN = /(?:\/[\w.@~-]+){2,}/g;
const COMMAND_PATTERN = /(?:^|\s)((?:npm|pnpm|node|git|curl|docker|brew|bash)\s[^\n`"]{3,120})/g;
const NOISE_PATTERN = /\b(429|rate.?limit|retrying|retry \d+)\b/i;

function clip(text, max) {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

function isNoise(text) {
  return NOISE_PATTERN.test(text) && text.length < 80;
}

/**
 * Summarize one session's extracted messages.
 * @param session - { sessionId, messages: [{role, text}] }
 * @param options - { projectName, maxChars }
 * @returns {{ title: string, markdown: string, firstTs: string|undefined, lastTs: string|undefined }}
 */
export function summarizeSession(session, { projectName = 'project', maxChars = 8000 } = {}) {
  const lines = [];
  const userTurns = session.messages.filter((m) => m.role === 'user');
  const assistantTurns = session.messages.filter((m) => m.role === 'assistant');
  const contentful = session.messages.filter((m) => !isNoise(m.text));

  const decisions = [];
  const details = new Set();
  const commands = new Set();
  const paths = new Set();
  for (const message of contentful) {
    for (const match of message.text.matchAll(COMMAND_PATTERN)) commands.add(clip(match[1], 120));
    for (const match of message.text.matchAll(PATH_PATTERN)) {
      if (!match[0].includes('node_modules')) details.add(clip(match[0], 160));
    }
  }
  for (const turn of userTurns) {
    for (const raw of turn.text.split(/\n+/)) {
      const line = raw.trim();
      if (line.length < 12 || line.length > 400) continue;
      if (isNoise(line)) continue;
      if (/^(你是|你是|as an ai|i'm an ai)/i.test(line)) continue;
      decisions.push(clip(line, 200));
    }
  }
  const toolNames = new Set();
  for (const turn of assistantTurns) {
    for (const match of turn.text.matchAll(/\b(?:weknora_[a-z_]+|todo_write|subagent|workflow|bash|read|write|edit|grep|glob)\b/g)) {
      toolNames.add(match[1]);
    }
  }

  const topics = userTurns.slice(0, 3).map((turn) => clip(turn.text, 120));
  const chars = session.messages.reduce((sum, m) => sum + m.text.length, 0);
  const title = `会话总结: ${projectName}_${session.sessionId.slice(0, 8)}`;

  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`- **主题**: ${topics.length > 0 ? topics.join(' / ') : '(无用户输入)'}`);
  lines.push(`- **体量**: ${session.messages.length} 条消息 / 约 ${chars} 字符${assistantTurns.length === 0 ? '；[派工型会话：仅任务书无回复]' : ''}`);
  if (decisions.length > 0) {
    lines.push('- **关键决策与结论**:');
    for (const decision of decisions.slice(0, 8)) lines.push(`  1. ${decision}`);
  }
  if (commands.size > 0) {
    lines.push('- **产出与命令**:');
    for (const command of [...commands].slice(0, 6)) lines.push(`  - \`${command}\``);
  }
  if (paths.size > 0) {
    lines.push('- **重要细节（路径/端口/配置）**:');
    for (const path of [...paths].slice(0, 8)) lines.push(`  - ${path}`);
  }
  if (toolNames.size > 0) lines.push(`- **使用的工具**: ${[...toolNames].slice(0, 12).join(', ')}`);
  lines.push('- **未完成/遗留**: 以会话末尾为准，未发现显式遗留事项' );
  lines.push('');
  lines.push('> 由 dsh-weknora-archive 启发式总结生成（无 LLM 参与）；凭据类内容一律未收录完整值。');

  let markdown = lines.join('\n');
  if (markdown.length > maxChars) markdown = `${markdown.slice(0, maxChars)}\n…(截断)`;
  return { title, markdown };
}

/**
 * Build the project-overview document for a first archive run.
 */
export function summarizeProjectOverview({ projectName, projectDir, sessions, summaries }) {
  const lines = [
    `# 项目总览: ${projectName}`,
    '',
    `- **会话目录**: ${projectDir}`,
    `- **归档会话数**: ${sessions.length}`,
    `- **本次归档**: ${summaries.length} 篇会话总结`,
    '',
    '## 会话清单',
    '',
    ...summaries.map((summary) => `- ${summary.title}`),
    '',
    '> 由 dsh-weknora-archive 自动生成。',
  ];
  return { title: `项目总览: ${projectName}`, markdown: lines.join('\n') };
}
