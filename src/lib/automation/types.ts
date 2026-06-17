import type { Json } from "../supabase/database.types";

export type AutomationTriggerType = "schedule" | "event" | "webhook";
export type AutomationFrequency = "daily" | "weekly" | "monthly";
export type AutomationTaskStatus = "draft" | "active" | "paused" | "archived";
export type AutomationRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "canceled";
export type AutomationTriggeredBy =
  | "schedule"
  | "event"
  | "webhook"
  | "manual"
  | "system";

export type AutomationNotificationChannel = "email" | "telegram" | "in-app";
export type AutomationInAppNotificationStatus = "unread" | "read";

export type AutomationSettings = {
  retryPolicy: "none" | "3-attempts" | "5-attempts";
  failureNotification: "email" | "in-app" | "none";
  notificationChannels: AutomationNotificationChannel[];
  notificationEmail?: string;
  notificationEmailLinkedAt?: string;
  notificationEmailPending?: string;
  notificationEmailVerified: boolean;
  telegramChatId?: string;
  telegramLinkedAt?: string;
  telegramUsername?: string;
  telegramVerified: boolean;
  autoPauseRepeatedFailures: boolean;
  developerModeEnabled: boolean;
  writeRunLogsToMemory: boolean;
  dailyLimit0G: string;
  monthlyCap0G: string;
  limitBehavior: "pause" | "alert" | "allow";
  lowBalanceThreshold0G: string;
  thresholdAction: "notify" | "pause" | "continue";
};

export type AutomationTask = {
  id: string;
  name: string;
  project: string;
  prompt?: string;
  model?: string;
  triggerType: AutomationTriggerType;
  scheduleFrequency?: AutomationFrequency;
  scheduleTime: string;
  scheduleWeekday?: number;
  scheduleMonthDay?: number;
  timezone: string;
  eventName?: string;
  webhookSlug?: string;
  status: AutomationTaskStatus;
  displayStatus: "Draft" | "Active" | "Paused" | "Running";
  triggerLabel: string;
  lastRunAt?: string;
  lastRunStatus?: AutomationRunStatus;
  nextRunAt?: string;
  consecutiveFailures: number;
  maxRetries: number;
  failureThreshold: number;
  metadata: Json;
  createdAt: string;
  updatedAt: string;
};

export type AutomationRun = {
  id: string;
  taskId: string;
  taskName?: string;
  status: AutomationRunStatus;
  triggeredBy: AutomationTriggeredBy;
  attempt: number;
  scheduledFor?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  result?: Json;
  usage?: Json;
  createdAt: string;
};

export type AutomationInAppNotification = {
  id: string;
  title: string;
  body: string;
  status: AutomationInAppNotificationStatus;
  taskId?: string;
  runId?: string;
  metadata: Json;
  readAt?: string;
  createdAt: string;
};

export type AutomationStats = {
  activeTasks: number;
  scheduledTasks: number;
  eventTasks: number;
  runningNow: number;
  successRate: number;
  nextRunAt?: string;
  nextRunTaskName?: string;
  pendingRuns: number;
  completedThisWeek: number;
};

export type AutomationDashboard = {
  configured: true;
  notifications: AutomationInAppNotification[];
  tasks: AutomationTask[];
  recentRuns: AutomationRun[];
  settings: AutomationSettings;
  stats: AutomationStats;
};

export type AutomationTaskInput = {
  name?: unknown;
  project?: unknown;
  prompt?: unknown;
  model?: unknown;
  triggerType?: unknown;
  scheduleFrequency?: unknown;
  scheduleTime?: unknown;
  scheduleWeekday?: unknown;
  scheduleMonthDay?: unknown;
  timezone?: unknown;
  eventName?: unknown;
  status?: unknown;
};

export type AutomationSettingsInput = {
  retryPolicy?: unknown;
  failureNotification?: unknown;
  notificationChannels?: unknown;
  notificationEmail?: unknown;
  telegramChatId?: unknown;
  autoPauseRepeatedFailures?: unknown;
  developerModeEnabled?: unknown;
  writeRunLogsToMemory?: unknown;
  dailyLimit0G?: unknown;
  monthlyCap0G?: unknown;
  limitBehavior?: unknown;
  lowBalanceThreshold0G?: unknown;
  thresholdAction?: unknown;
};
