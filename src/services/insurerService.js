const fs = require('fs');
const path = require('path');
const createDebug = require('debug');

const debug = createDebug('app:service:insurer');
const DEFAULT_LIST_PATH = process.env.INSURER_LIST_PATH || path.join(__dirname, '..', 'data', 'insurers.json');
const SIMILARITY_THRESHOLD = 0.68;

let cachedInsurers = null;
let cachedPath = null;

async function loadInsurers() {
  const listPath = DEFAULT_LIST_PATH;
  if (cachedInsurers && cachedPath === listPath) {
    return cachedInsurers;
  }

  try {
    const data = await fs.promises.readFile(listPath, 'utf8');
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) {
      throw new Error('insurer list must be a JSON array of strings');
    }
    cachedInsurers = parsed.filter((item) => typeof item === 'string' && item.trim().length > 0);
    cachedPath = listPath;
    return cachedInsurers;
  } catch (error) {
    debug('Failed to load insurer list from %s: %s', listPath, error.message);
    cachedInsurers = [];
    cachedPath = listPath;
    return cachedInsurers;
  }
}

function normalizeName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  const prevRow = Array.from({ length: bLen + 1 }, (_, i) => i);
  const currRow = new Array(bLen + 1);

  for (let i = 0; i < aLen; i += 1) {
    currRow[0] = i + 1;
    for (let j = 0; j < bLen; j += 1) {
      const cost = a[i] === b[j] ? 0 : 1;
      currRow[j + 1] = Math.min(
        currRow[j] + 1, // insertion
        prevRow[j + 1] + 1, // deletion
        prevRow[j] + cost // substitution
      );
    }
    for (let j = 0; j <= bLen; j += 1) {
      prevRow[j] = currRow[j];
    }
  }

  return prevRow[bLen];
}

function similarityScore(a, b) {
  const normA = normalizeName(a);
  const normB = normalizeName(b);
  if (!normA || !normB) return 0;
  const distance = levenshtein(normA, normB);
  return 1 - distance / Math.max(normA.length, normB.length);
}

async function correctInsurerName(candidate) {
  const insurers = await loadInsurers();
  if (!candidate || typeof candidate !== 'string' || insurers.length === 0) {
    return { correctedName: candidate, bestMatch: null, score: null };
  }

  const normalizedCandidate = normalizeName(candidate);
  let bestMatch = null;
  let bestScore = 0;

  for (const insurer of insurers) {
    const score = similarityScore(normalizedCandidate, insurer);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = insurer;
    }
  }

  if (bestMatch && bestScore >= SIMILARITY_THRESHOLD) {
    return { correctedName: bestMatch, bestMatch, score: bestScore };
  }

  return { correctedName: candidate, bestMatch, score: bestScore };
}

module.exports = {
  correctInsurerName,
  loadInsurers,
};
