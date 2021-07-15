import pleaseUpgradeNode from 'please-upgrade-node';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const packageJson = require('../package.json'); // eslint-disable-line @typescript-eslint/no-var-requires

pleaseUpgradeNode(packageJson);

export {
  default as App,
  AppOptions,
  Authorize,
  AuthorizeSourceData,
  AuthorizeResult,
  ActionConstraints,
  LogLevel,
  Logger,
} from './App';

export { default as ExpressReceiver, ExpressReceiverOptions } from './receivers/ExpressReceiver';
export { default as SocketModeReceiver, SocketModeReceiverOptions } from './receivers/SocketModeReceiver';
export { default as HTTPReceiver, HTTPReceiverOptions } from './receivers/HTTPReceiver';
export { default as AwsLambdaReceiver, AwsLambdaReceiverOptions } from './receivers/AwsLambdaReceiver';

export * from './errors';
export * from './middleware/builtin';
export * from './types';

export { ConversationStore, MemoryStore } from './conversation-store';

export {
  WorkflowStep,
  WorkflowStepConfig,
  WorkflowStepEditMiddleware,
  WorkflowStepSaveMiddleware,
  WorkflowStepExecuteMiddleware,
} from './WorkflowStep';

export {
  Installation,
  InstallURLOptions,
  InstallationQuery,
  InstallationStore,
  MemoryInstallationStore,
  FileInstallationStore,
  StateStore,
  InstallProviderOptions,
} from '@slack/oauth';

export * from '@slack/types';
