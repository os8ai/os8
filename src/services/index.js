/**
 * OS8 Services
 * Re-exports public services for convenient importing.
 * Internal helper modules (work-queue-prompts, sim-helpers, etc.) are intentionally excluded.
 */

const ClaudeInstructionsService = require('./claude-instructions');
const SettingsService = require('./settings');
const EnvService = require('./env');
const { ConnectionsService, PROVIDERS } = require('./connections');
const CoreService = require('./core');
const TasksFileService = require('./tasks-file');
const { JobsFileService } = require('./jobs-file');
const JobSchedulerService = require('./job-scheduler');
const { WorkQueue } = require('./work-queue');
const {
  AppService,
  scaffoldApp,
  scaffoldAssistantApp,
  generateClaudeMd,
  generateAssistantClaudeMd
} = require('./app');
const AgentService = require('./agent');
const AppDbService = require('./app-db');
const WhisperService = require('./whisper');
const WhisperStreamService = require('./whisper-stream');
const TTSService = require('./tts');
const TranscribeService = require('./transcribe');
const SpeakService = require('./speak');
const ImageGenService = require('./imagegen');
const CallService = require('./call');
const TunnelService = require('./tunnel');
const DataStorageService = require('./data-storage');
const ConversationService = require('./conversation');
const DigestService = require('./digest');
const BuzzService = require('./buzz');
const EmbodiedService = require('./embodiment');
const VideoGenService = require('./videogen');
const { getBackend, getCommand, getInstructionFile, BACKENDS } = require('./backend-adapter');
const AnthropicSDK = require('./anthropic-sdk');
const ModeratorService = require('./moderator');
const { ThreadOrchestrator, PRIORITY_THREAD } = require('./thread-orchestrator');
const AppBuilderService = require('./app-builder');
const AppInspectorService = require('./app-inspector');
const SimService = require('./sim');
const YouTubeService = require('./youtube');
const { CapabilityService } = require('./capability');
const CapabilitySyncService = require('./capability-sync');
const SkillCatalogService = require('./skill-catalog');
const AIRegistryService = require('./ai-registry');
const ModelDiscoveryService = require('./model-discovery');
const RoutingService = require('./routing');
const BillingService = require('./billing');
const McpServerService = require('./mcp-server');
const McpCatalogService = require('./mcp-catalog');
const SkillReviewService = require('./skill-review');
const AccountService = require('./account');
const PlanService = require('./plan');
const PlanCommandService = require('./plan-command');
const { PlanExecutorService, PLAN_STEP_PRIORITY } = require('./plan-executor');
const { StreamStateTracker, labelStep, extractStepsFromResponse } = require('./stream-tracker');
const SubconsciousService = require('./subconscious');
const PrinciplesService = require('./principles');
const { buildPlanningPrompt, planWithModel, extractJson } = require('./plan-generator');
const AgentChatService = require('./agent-chat');
const TelegramService = require('./telegram');
const DigestEngine = require('./digest-engine');
const CliRunner = require('./cli-runner');
const ClaudeProtocol = require('./claude-protocol');
const TtsElevenlabs = require('./tts-elevenlabs');
const TtsOpenai = require('./tts-openai');
const AgentState = require('./agent-state');
const PTYService = require('./pty');
const PreviewService = require('./preview');
const FileSystemService = require('./filesystem');

module.exports = {
  ClaudeInstructionsService,
  SettingsService,
  EnvService,
  ConnectionsService,
  PROVIDERS,
  CapabilityService,
  CapabilitySyncService,
  CoreService,
  TasksFileService,
  JobsFileService,
  JobSchedulerService,
  WorkQueue,
  AppService,
  AppDbService,
  AgentService,
  scaffoldApp,
  scaffoldAssistantApp,
  generateClaudeMd,
  generateAssistantClaudeMd,
  WhisperService,
  WhisperStreamService,
  TTSService,
  TranscribeService,
  SpeakService,
  ImageGenService,
  CallService,
  TunnelService,
  DataStorageService,
  ConversationService,
  DigestService,
  BuzzService,
  EmbodiedService,
  VideoGenService,
  getBackend,
  getCommand,
  getInstructionFile,
  BACKENDS,
  AnthropicSDK,
  ModeratorService,
  ThreadOrchestrator,
  PRIORITY_THREAD,
  AppBuilderService,
  AppInspectorService,
  SimService,
  YouTubeService,
  SkillCatalogService,
  AIRegistryService,
  ModelDiscoveryService,
  RoutingService,
  BillingService,
  McpServerService,
  McpCatalogService,
  SkillReviewService,
  AccountService,
  PlanService,
  PlanCommandService,
  PlanExecutorService,
  PLAN_STEP_PRIORITY,
  StreamStateTracker,
  labelStep,
  extractStepsFromResponse,
  buildPlanningPrompt,
  planWithModel,
  extractJson,
  SubconsciousService,
  PrinciplesService,
  AgentChatService,
  TelegramService,
  DigestEngine,
  CliRunner,
  ClaudeProtocol,
  TtsElevenlabs,
  TtsOpenai,
  AgentState,
  PTYService,
  PreviewService,
  FileSystemService
};
