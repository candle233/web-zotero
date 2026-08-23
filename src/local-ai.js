'use strict';

const STOP_WORDS = new Set(`a about above after again against all am an and any are as at be because been before being below between both but by could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you your yours yourself yourselves it's don't isn't we're`.split(/\s+/));

function sentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 35 && sentence.length < 420);
}

function keywords(text, limit = 18) {
  const frequencies = new Map();
  for (const rawWord of String(text || '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []) {
    const word = rawWord.replace(/(?:['-](?:s|ed|ing))+$/, '');
    if (word.length < 3 || STOP_WORDS.has(word)) continue;
    frequencies.set(word, (frequencies.get(word) || 0) + 1);
  }
  return [...frequencies.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function rankSentences(list, terms, limit) {
  return list
    .map((sentence, index) => {
      const lower = sentence.toLowerCase();
      const density = terms.reduce((total, term) => total + (lower.includes(term[0]) ? term[1] : 0), 0);
      const positionBonus = Math.max(0, 1 - index / Math.max(12, list.length));
      const lengthPenalty = Math.abs(sentence.length - 180) / 500;
      return { sentence, index, score: density * 1.5 + positionBonus - lengthPenalty };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map(entry => entry.sentence);
}

function localSummary({ title = '', authors = [], text = '' }) {
  const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleanText) throw new Error('No extracted text is available for this PDF.');
  const allSentences = sentences(cleanText);
  if (allSentences.length < 2) throw new Error('The extracted PDF text is too short to analyze.');
  const terms = keywords(cleanText.slice(0, 120000));
  const abstractMatch = cleanText.match(/abstract\b[:.]?\s*(.{80,3500}?)(?:\bintroduction\b|\bkeywords\b|\bindex terms\b|$)/i);
  const important = rankSentences(allSentences, terms, 7);
  const points = [...important];
  if (points.length < 5) points.push(...rankSentences(allSentences.slice(Math.floor(allSentences.length / 2)), terms, 5 - points.length));
  return {
    provider: 'local',
    title,
    abstract: abstractMatch ? abstractMatch[1].trim() : '',
    summary: important.join(' ') || cleanText.slice(0, 900),
    keyPoints: [...new Set(points)].slice(0, 8),
    keywords: terms.map(([term]) => term),
    suggestedQuestions: [
      `What problem does "${title || 'this paper'}" address?`,
      authors.length ? `How do ${authors.slice(0, 2).join(' and ')} justify their method?` : 'What evidence supports the paper’s claims?',
      `What are the limitations of ${title || 'the study'}?`,
      `Which methods or datasets are central to this paper?`
    ]
  };
}

async function openAiSummary({ apiKey, baseUrl = 'https://api.openai.com/v1', model = 'gpt-4o-mini', title = '', authors = [], text = '' }) {
  const excerpt = String(text || '').replace(/\s+/g, ' ').slice(0, 60000);
  if (!excerpt) throw new Error('No extracted text is available for this PDF.');
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(45000),
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'You are an academic reading assistant. Answer with clear Markdown headings: Summary, Key Points, Important Details, Suggested Questions.' },
        { role: 'user', content: `Title: ${title}\nAuthors: ${authors.join(', ')}\n\nExtracted paper text:\n${excerpt}` }
      ]
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || `OpenAI request failed (${response.status}).`);
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned an empty response.');
  return { provider: `openai:${model}`, title, authors, markdown: content, keyPoints: [], keywords: [] };
}

module.exports = { localSummary, openAiSummary, keywords, sentences };
