// The learning features (Study, Review, Test, the voice coach, clips and cards). The rest of
// the app reaches them only through these names.

export { scheduleClipStep } from "./clips.js";
export {
  cardKeySet, currentExposureMediaKey, learningItemKey, learningRevision, masteredCardKeySet,
  migrateLearningState, recordCueExposure, saveLearningExposure, touchLearningState,
} from "./learning-state.js";
export { handleQuizKey, handleStudyKey, handleTestKey, wireLearningViews } from "./learning-views.js";
export { renderReview } from "./review-quiz.js";
export { renderTest } from "./scored-tests.js";
export {
  closeLinePreview, exportCardsToAnki, importAnkiFile, linePreview, playNextStudySound,
  playStudySounds, replayLinePreview, revealStudyAnswer, stopStudySounds, studyAudio,
} from "./study-decks.js";
export { renderStudyPage } from "./study-page.js";
export { renderStudy } from "./study-vocabulary.js";
export {
  addDiscardedAutoCardKeys, backfillPersistedChapterAutoCards, currentAnalysis,
  discardedAutoCardKeys, ensureLearningPreset, learningPresetCache, persistDiscardedAutoCardKeys,
  restoreDiscardedAutoCardKeys, saveCurrentEpisodeAnalysis, showLibraryVocabulary,
} from "./vocabulary-cards.js";
export {
  applyVoicePreferences, browserCoachChecking, browserCoachStatus, changeReviewTargetLanguage,
  closeLiveCoachSession, coachProviderId, coachProviders, coachProviderShortLabel,
  connectBrowserCoach, openBrowserCoachExtensionFolder, refreshBrowserCoachStatus,
  refreshCoachProviders, refreshVoiceUsageStatus, renderBrowserCoachStatus, renderVoiceChatStage,
  restoreVoiceSession, reviewMode, selectedCoachProvider, setCoachProvider, setReviewTab,
  stopVoiceSpeech, stopVoiceUsageClock, voiceAudio, voiceChat, voiceLiveAssistance,
  voiceLivePresetId, voiceRecognition, voiceUsageActiveSince, voiceUsageSegments,
  wireBrowserCoachMessages,
} from "./voice-coach.js";
