import { createWordProvider, WordBoundaryCache, type WordProvider } from "../../word";
import { createSentenceProvider, type SentenceProvider } from "../../word/sentence";

/** Only the embedded adapter installs these provider slots. */
export function installWordProvider(
  cm: {
    state: { wordBoundaryProvider?: WordProvider; sentenceBoundaryProvider?: SentenceProvider };
  },
  cache = new WordBoundaryCache(),
): () => void {
  const previous = cm.state.wordBoundaryProvider;
  const previousSentences = cm.state.sentenceBoundaryProvider;
  const provider = createWordProvider(cache);
  const sentences = createSentenceProvider(cache);
  cm.state.wordBoundaryProvider = provider;
  cm.state.sentenceBoundaryProvider = sentences;
  return () => {
    if (cm.state.wordBoundaryProvider === provider) cm.state.wordBoundaryProvider = previous;
    if (cm.state.sentenceBoundaryProvider === sentences)
      cm.state.sentenceBoundaryProvider = previousSentences;
    cache.clear();
  };
}
