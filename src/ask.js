'use strict';

/**
 * RAG question answering over the indexed full text (R8, local form).
 *
 * Retrieval: LSA cosine (when the semantic index is ready) blended with
 * lexical term overlap. Generation: OpenAI when OPENAI_API_KEY is set,
 * otherwise a deterministic extractive answer built from the best sentences
 * of the top passages (Chinese- and English-aware sentence splitting).
 */

const { tokenize } = require('./semantic');

const MAX_PASSAGES = 4;
const MAX_ANSWER_SENTENCES = 5;

function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？!?.])\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 8 && sentence.length <= 500);
}

function scoreChunk(chunk, questionTokens, queryVector, dimensions) {
  let semantic = 0;
  if (queryVector && chunk.vec) {
    for (let j = 0; j < dimensions; j += 1) semantic += queryVector[j] * chunk.vec[j];
  }
  const chunkTokens = new Set(tokenize(chunk.text));
  let matched = 0;
  for (const token of questionTokens) {
    if (chunkTokens.has(token)) matched += 1;
  }
  const lexical = questionTokens.length ? matched / questionTokens.length : 0;
  return 0.55 * Math.max(0, semantic) + 0.45 * lexical;
}

function retrieve({ question, itemKey, semanticIndex }) {
  const questionTokens = [...new Set(tokenize(question))];
  if (!questionTokens.length) throw Object.assign(new Error('The question contains no searchable terms.'), { statusCode: 400 });
  const queryVector = semanticIndex.ready ? semanticIndex.projectQuery(question) : null;
  const dimensions = semanticIndex.k;
  const candidates = semanticIndex.ready
    ? (itemKey ? semanticIndex.chunksFor(itemKey) : semanticIndex.chunkVectors)
    : [];
  let ranked = candidates
    .map(chunk => ({
      chunk,
      score: scoreChunk(chunk, questionTokens, queryVector, dimensions)
    }))
    .filter(entry => entry.score > 0.01)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PASSAGES);
  return { questionTokens, ranked };
}

function extractiveAnswer(questionTokens, ranked) {
  const scored = [];
  for (const [passageIndex, entry] of ranked.entries()) {
    for (const [sentenceIndex, sentence] of splitSentences(entry.chunk.text).entries()) {
      const sentenceTokens = new Set(tokenize(sentence));
      let matched = 0;
      for (const token of questionTokens) {
        if (sentenceTokens.has(token)) matched += 1;
      }
      if (!matched) continue;
      const coverage = matched / questionTokens.length;
      const positionBonus = Math.max(0, 0.3 - sentenceIndex * 0.03);
      scored.push({
        sentence,
        passageIndex,
        sentenceIndex,
        score: coverage * 1.6 + entry.score + positionBonus
      });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ANSWER_SENTENCES)
    .sort((a, b) => a.passageIndex - b.passageIndex || a.sentenceIndex - b.sentenceIndex)
    .map(entry => entry.sentence);
}

async function openAiAnswer({ apiKey, baseUrl = 'https://api.openai.com/v1', model = 'gpt-4o-mini', question, passages }) {
  const context = passages
    .map((passage, index) => `[${index + 1}] ${passage.title || 'Untitled'} (score ${passage.score.toFixed(3)})\n${passage.snippet}`)
    .join('\n\n');
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'You are an academic reading assistant. Answer the question using ONLY the numbered passages. Cite passages as [1], [2] after the claims they support. If the passages do not contain the answer, say so explicitly.'
        },
        { role: 'user', content: `Passages:\n${context}\n\nQuestion: ${question}` }
      ]
    }),
    signal: AbortSignal.timeout(45000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || `OpenAI request failed (${response.status}).`);
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned an empty response.');
  return content;
}

async function ask({ question, itemKey = null, semanticIndex, apiKey = '', model, baseUrl }) {
  const cleanQuestion = String(question || '').trim();
  if (!cleanQuestion) throw Object.assign(new Error('Field "question" is required.'), { statusCode: 400 });

  const { questionTokens, ranked } = retrieve({ question: cleanQuestion, itemKey, semanticIndex });
  const passages = ranked.map(entry => ({
    itemKey: entry.chunk.itemKey,
    attachmentKey: entry.chunk.attachmentKey,
    title: entry.chunk.title,
    snippet: entry.chunk.text.length > 600 ? `${entry.chunk.text.slice(0, 600)}…` : entry.chunk.text,
    score: Number(entry.score.toFixed(4))
  }));

  if (apiKey) {
    try {
      const answer = await openAiAnswer({ apiKey, model, baseUrl, question: cleanQuestion, passages });
      return { provider: `openai:${model || 'gpt-4o-mini'}`, question: cleanQuestion, itemKey, answer, passages };
    } catch (error) {
      const fallback = localResult(cleanQuestion, itemKey, questionTokens, ranked, passages);
      return { ...fallback, warning: `OpenAI failed; local extraction used instead: ${error.message}` };
    }
  }
  return localResult(cleanQuestion, itemKey, questionTokens, ranked, passages);
}

function localResult(question, itemKey, questionTokens, ranked, passages) {
  const sentences = extractiveAnswer(questionTokens, ranked);
  if (!sentences.length) {
    return {
      provider: 'local',
      question,
      itemKey,
      answer: passages.length
        ? 'The indexed text does not directly address this question. Try rephrasing with terms from the paper.'
        : 'No indexed full text is available to answer this question yet.',
      passages
    };
  }
  return { provider: 'local', question, itemKey, answer: sentences.join(' '), passages };
}

module.exports = { ask, splitSentences };
