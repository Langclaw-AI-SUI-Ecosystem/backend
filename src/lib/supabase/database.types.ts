export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      langclaw_wallet_users: {
        Row: {
          created_at: string;
          id: string;
          last_login_message: string | null;
          last_seen_at: string;
          last_signature: string | null;
          updated_at: string;
          wallet_address: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          last_login_message?: string | null;
          last_seen_at?: string;
          last_signature?: string | null;
          updated_at?: string;
          wallet_address: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          last_login_message?: string | null;
          last_seen_at?: string;
          last_signature?: string | null;
          updated_at?: string;
          wallet_address?: string;
        };
        Relationships: [];
      };
      langclaw_api_keys: {
        Row: {
          created_at: string;
          id: string;
          key_hash: string;
          key_prefix: string;
          key_suffix: string;
          last_used_at: string | null;
          name: string;
          revoked_at: string | null;
          status: "active" | "revoked";
          updated_at: string;
          wallet_user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          key_hash: string;
          key_prefix: string;
          key_suffix: string;
          last_used_at?: string | null;
          name: string;
          revoked_at?: string | null;
          status?: "active" | "revoked";
          updated_at?: string;
          wallet_user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          key_hash?: string;
          key_prefix?: string;
          key_suffix?: string;
          last_used_at?: string | null;
          name?: string;
          revoked_at?: string | null;
          status?: "active" | "revoked";
          updated_at?: string;
          wallet_user_id?: string;
        };
        Relationships: [];
      };
      langclaw_alpha_watchlist: {
        Row: {
          added_at: string;
          agent_id: string | null;
          caveat: string;
          chain: string;
          created_at: string;
          decision_hash: string | null;
          decision_id: string | null;
          evidence_uri: string | null;
          explorer_url: string | null;
          gap_count: number;
          id: string;
          intent: string;
          proof_tx: string | null;
          recommendation: string;
          signal_type: string;
          source_count: number;
          subject: string;
          summary: string;
          title: string;
          updated_at: string;
          wallet_user_id: string;
        };
        Insert: {
          added_at?: string;
          agent_id?: string | null;
          caveat: string;
          chain?: string;
          created_at?: string;
          decision_hash?: string | null;
          decision_id?: string | null;
          evidence_uri?: string | null;
          explorer_url?: string | null;
          gap_count?: number;
          id: string;
          intent: string;
          proof_tx?: string | null;
          recommendation: string;
          signal_type: string;
          source_count?: number;
          subject: string;
          summary: string;
          title: string;
          updated_at?: string;
          wallet_user_id: string;
        };
        Update: {
          added_at?: string;
          agent_id?: string | null;
          caveat?: string;
          chain?: string;
          created_at?: string;
          decision_hash?: string | null;
          decision_id?: string | null;
          evidence_uri?: string | null;
          explorer_url?: string | null;
          gap_count?: number;
          id?: string;
          intent?: string;
          proof_tx?: string | null;
          recommendation?: string;
          signal_type?: string;
          source_count?: number;
          subject?: string;
          summary?: string;
          title?: string;
          updated_at?: string;
          wallet_user_id?: string;
        };
        Relationships: [];
      };
      langclaw_chat_sessions: {
        Row: {
          created_at: string;
          id: string;
          pinned: boolean;
          title: string;
          updated_at: string;
          wallet_user_id: string;
        };
        Insert: {
          created_at?: string;
          id: string;
          pinned?: boolean;
          title: string;
          updated_at?: string;
          wallet_user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          pinned?: boolean;
          title?: string;
          updated_at?: string;
          wallet_user_id?: string;
        };
        Relationships: [];
      };
      langclaw_chat_messages: {
        Row: {
          content: string;
          created_at: string;
          direct_answer: Json | null;
          error: string | null;
          id: string;
          mode: "chat" | "onchain" | "research" | null;
          model: string | null;
          onchain_result: Json | null;
          position: number;
          progress_events: Json | null;
          result: Json | null;
          role: "assistant" | "user";
          session_id: string;
          stopped: boolean;
          wallet_user_id: string;
        };
        Insert: {
          content: string;
          created_at?: string;
          direct_answer?: Json | null;
          error?: string | null;
          id: string;
          mode?: "chat" | "onchain" | "research" | null;
          model?: string | null;
          onchain_result?: Json | null;
          position?: number;
          progress_events?: Json | null;
          result?: Json | null;
          role: "assistant" | "user";
          session_id: string;
          stopped?: boolean;
          wallet_user_id: string;
        };
        Update: {
          content?: string;
          created_at?: string;
          direct_answer?: Json | null;
          error?: string | null;
          id?: string;
          mode?: "chat" | "onchain" | "research" | null;
          model?: string | null;
          onchain_result?: Json | null;
          position?: number;
          progress_events?: Json | null;
          result?: Json | null;
          role?: "assistant" | "user";
          session_id?: string;
          stopped?: boolean;
          wallet_user_id?: string;
        };
        Relationships: [];
      };
      langclaw_research_runs: {
        Row: {
          created_at: string;
          id: string;
          message_id: string | null;
          proof: Json | null;
          result: Json;
          session_id: string;
          topic: string;
          wallet_user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          message_id?: string | null;
          proof?: Json | null;
          result: Json;
          session_id: string;
          topic: string;
          wallet_user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          message_id?: string | null;
          proof?: Json | null;
          result?: Json;
          session_id?: string;
          topic?: string;
          wallet_user_id?: string;
        };
        Relationships: [];
      };
      langclaw_memories: {
        Row: {
          category: "Preference" | "Project" | "Workflow" | "Personal" | "API";
          confidence: number;
          created_at: string;
          id: string;
          last_used_at: string | null;
          memory: string;
          metadata: Json;
          scope: string;
          source: string;
          status: "active" | "disabled";
          updated_at: string;
          wallet_user_id: string;
        };
        Insert: {
          category?: "Preference" | "Project" | "Workflow" | "Personal" | "API";
          confidence?: number;
          created_at?: string;
          id?: string;
          last_used_at?: string | null;
          memory: string;
          metadata?: Json;
          scope?: string;
          source?: string;
          status?: "active" | "disabled";
          updated_at?: string;
          wallet_user_id: string;
        };
        Update: {
          category?: "Preference" | "Project" | "Workflow" | "Personal" | "API";
          confidence?: number;
          created_at?: string;
          id?: string;
          last_used_at?: string | null;
          memory?: string;
          metadata?: Json;
          scope?: string;
          source?: string;
          status?: "active" | "disabled";
          updated_at?: string;
          wallet_user_id?: string;
        };
        Relationships: [];
      };
      langclaw_memory_settings: {
        Row: {
          auto_disable_low_confidence: boolean;
          capture_enabled: boolean;
          created_at: string;
          cross_chat_recall: boolean;
          project_scoped_recall: boolean;
          retention_days: number;
          updated_at: string;
          wallet_user_id: string;
        };
        Insert: {
          auto_disable_low_confidence?: boolean;
          capture_enabled?: boolean;
          created_at?: string;
          cross_chat_recall?: boolean;
          project_scoped_recall?: boolean;
          retention_days?: number;
          updated_at?: string;
          wallet_user_id: string;
        };
        Update: {
          auto_disable_low_confidence?: boolean;
          capture_enabled?: boolean;
          created_at?: string;
          cross_chat_recall?: boolean;
          project_scoped_recall?: boolean;
          retention_days?: number;
          updated_at?: string;
          wallet_user_id?: string;
        };
        Relationships: [];
      };
      langclaw_automation_settings: {
        Row: {
          auto_pause_repeated_failures: boolean;
          created_at: string;
          daily_limit_neuron: string;
          developer_mode_enabled: boolean;
          failure_notification: "email" | "in-app" | "none";
          limit_behavior: "pause" | "alert" | "allow";
          low_balance_threshold_neuron: string;
          monthly_cap_neuron: string;
          notification_email_code_hash: string | null;
          notification_email_expires_at: string | null;
          notification_email_linked_at: string | null;
          notification_email_pending: string | null;
          notification_email_verified: boolean;
          notification_channels: Array<"email" | "telegram" | "in-app">;
          notification_email: string | null;
          retry_policy: "none" | "3-attempts" | "5-attempts";
          telegram_chat_id: string | null;
          telegram_link_code_hash: string | null;
          telegram_link_expires_at: string | null;
          telegram_linked_at: string | null;
          telegram_username: string | null;
          telegram_verified: boolean;
          threshold_action: "notify" | "pause" | "continue";
          updated_at: string;
          wallet_user_id: string;
          write_run_logs_to_memory: boolean;
        };
        Insert: {
          auto_pause_repeated_failures?: boolean;
          created_at?: string;
          daily_limit_neuron?: string;
          developer_mode_enabled?: boolean;
          failure_notification?: "email" | "in-app" | "none";
          limit_behavior?: "pause" | "alert" | "allow";
          low_balance_threshold_neuron?: string;
          monthly_cap_neuron?: string;
          notification_email_code_hash?: string | null;
          notification_email_expires_at?: string | null;
          notification_email_linked_at?: string | null;
          notification_email_pending?: string | null;
          notification_email_verified?: boolean;
          notification_channels?: Array<"email" | "telegram" | "in-app">;
          notification_email?: string | null;
          retry_policy?: "none" | "3-attempts" | "5-attempts";
          telegram_chat_id?: string | null;
          telegram_link_code_hash?: string | null;
          telegram_link_expires_at?: string | null;
          telegram_linked_at?: string | null;
          telegram_username?: string | null;
          telegram_verified?: boolean;
          threshold_action?: "notify" | "pause" | "continue";
          updated_at?: string;
          wallet_user_id: string;
          write_run_logs_to_memory?: boolean;
        };
        Update: {
          auto_pause_repeated_failures?: boolean;
          created_at?: string;
          daily_limit_neuron?: string;
          developer_mode_enabled?: boolean;
          failure_notification?: "email" | "in-app" | "none";
          limit_behavior?: "pause" | "alert" | "allow";
          low_balance_threshold_neuron?: string;
          monthly_cap_neuron?: string;
          notification_email_code_hash?: string | null;
          notification_email_expires_at?: string | null;
          notification_email_linked_at?: string | null;
          notification_email_pending?: string | null;
          notification_email_verified?: boolean;
          notification_channels?: Array<"email" | "telegram" | "in-app">;
          notification_email?: string | null;
          retry_policy?: "none" | "3-attempts" | "5-attempts";
          telegram_chat_id?: string | null;
          telegram_link_code_hash?: string | null;
          telegram_link_expires_at?: string | null;
          telegram_linked_at?: string | null;
          telegram_username?: string | null;
          telegram_verified?: boolean;
          threshold_action?: "notify" | "pause" | "continue";
          updated_at?: string;
          wallet_user_id?: string;
          write_run_logs_to_memory?: boolean;
        };
        Relationships: [];
      };
      langclaw_automation_tasks: {
        Row: {
          consecutive_failures: number;
          created_at: string;
          event_name: string | null;
          failure_threshold: number;
          id: string;
          last_run_at: string | null;
          last_run_status:
            | "queued"
            | "running"
            | "completed"
            | "failed"
            | "skipped"
            | "canceled"
            | null;
          max_retries: number;
          metadata: Json;
          model: string | null;
          name: string;
          next_run_at: string | null;
          project: string;
          prompt: string | null;
          schedule_frequency: "daily" | "weekly" | "monthly" | null;
          schedule_month_day: number | null;
          schedule_time: string;
          schedule_weekday: number | null;
          status: "draft" | "active" | "paused" | "archived";
          timezone: string;
          trigger_type: "schedule" | "event" | "webhook";
          updated_at: string;
          wallet_user_id: string;
          webhook_slug: string | null;
        };
        Insert: {
          consecutive_failures?: number;
          created_at?: string;
          event_name?: string | null;
          failure_threshold?: number;
          id?: string;
          last_run_at?: string | null;
          last_run_status?:
            | "queued"
            | "running"
            | "completed"
            | "failed"
            | "skipped"
            | "canceled"
            | null;
          max_retries?: number;
          metadata?: Json;
          model?: string | null;
          name: string;
          next_run_at?: string | null;
          project?: string;
          prompt?: string | null;
          schedule_frequency?: "daily" | "weekly" | "monthly" | null;
          schedule_month_day?: number | null;
          schedule_time?: string;
          schedule_weekday?: number | null;
          status?: "draft" | "active" | "paused" | "archived";
          timezone?: string;
          trigger_type?: "schedule" | "event" | "webhook";
          updated_at?: string;
          wallet_user_id: string;
          webhook_slug?: string | null;
        };
        Update: {
          consecutive_failures?: number;
          created_at?: string;
          event_name?: string | null;
          failure_threshold?: number;
          id?: string;
          last_run_at?: string | null;
          last_run_status?:
            | "queued"
            | "running"
            | "completed"
            | "failed"
            | "skipped"
            | "canceled"
            | null;
          max_retries?: number;
          metadata?: Json;
          model?: string | null;
          name?: string;
          next_run_at?: string | null;
          project?: string;
          prompt?: string | null;
          schedule_frequency?: "daily" | "weekly" | "monthly" | null;
          schedule_month_day?: number | null;
          schedule_time?: string;
          schedule_weekday?: number | null;
          status?: "draft" | "active" | "paused" | "archived";
          timezone?: string;
          trigger_type?: "schedule" | "event" | "webhook";
          updated_at?: string;
          wallet_user_id?: string;
          webhook_slug?: string | null;
        };
        Relationships: [];
      };
      langclaw_automation_runs: {
        Row: {
          attempt: number;
          completed_at: string | null;
          created_at: string;
          duration_ms: number | null;
          error: string | null;
          id: string;
          result: Json | null;
          scheduled_for: string | null;
          started_at: string | null;
          status:
            | "queued"
            | "running"
            | "completed"
            | "failed"
            | "skipped"
            | "canceled";
          task_id: string;
          triggered_by: "schedule" | "event" | "webhook" | "manual" | "system";
          usage: Json | null;
          wallet_user_id: string;
        };
        Insert: {
          attempt?: number;
          completed_at?: string | null;
          created_at?: string;
          duration_ms?: number | null;
          error?: string | null;
          id?: string;
          result?: Json | null;
          scheduled_for?: string | null;
          started_at?: string | null;
          status?:
            | "queued"
            | "running"
            | "completed"
            | "failed"
            | "skipped"
            | "canceled";
          task_id: string;
          triggered_by?: "schedule" | "event" | "webhook" | "manual" | "system";
          usage?: Json | null;
          wallet_user_id: string;
        };
        Update: {
          attempt?: number;
          completed_at?: string | null;
          created_at?: string;
          duration_ms?: number | null;
          error?: string | null;
          id?: string;
          result?: Json | null;
          scheduled_for?: string | null;
          started_at?: string | null;
          status?:
            | "queued"
            | "running"
            | "completed"
            | "failed"
            | "skipped"
            | "canceled";
          task_id?: string;
          triggered_by?: "schedule" | "event" | "webhook" | "manual" | "system";
          usage?: Json | null;
          wallet_user_id?: string;
        };
        Relationships: [];
      };
      langclaw_automation_notifications: {
        Row: {
          body: string;
          created_at: string;
          id: string;
          metadata: Json;
          read_at: string | null;
          run_id: string | null;
          status: "unread" | "read";
          task_id: string | null;
          title: string;
          wallet_user_id: string;
        };
        Insert: {
          body: string;
          created_at?: string;
          id?: string;
          metadata?: Json;
          read_at?: string | null;
          run_id?: string | null;
          status?: "unread" | "read";
          task_id?: string | null;
          title: string;
          wallet_user_id: string;
        };
        Update: {
          body?: string;
          created_at?: string;
          id?: string;
          metadata?: Json;
          read_at?: string | null;
          run_id?: string | null;
          status?: "unread" | "read";
          task_id?: string | null;
          title?: string;
          wallet_user_id?: string;
        };
        Relationships: [];
      };
      langclaw_usage_accounts: {
        Row: {
          available_neuron: string;
          created_at: string;
          lifetime_charged_neuron: string;
          lifetime_deposited_neuron: string;
          reserved_neuron: string;
          updated_at: string;
          wallet_address: string;
          wallet_user_id: string;
        };
        Insert: {
          available_neuron?: string;
          created_at?: string;
          lifetime_charged_neuron?: string;
          lifetime_deposited_neuron?: string;
          reserved_neuron?: string;
          updated_at?: string;
          wallet_address: string;
          wallet_user_id: string;
        };
        Update: {
          available_neuron?: string;
          created_at?: string;
          lifetime_charged_neuron?: string;
          lifetime_deposited_neuron?: string;
          reserved_neuron?: string;
          updated_at?: string;
          wallet_address?: string;
          wallet_user_id?: string;
        };
        Relationships: [];
      };
      langclaw_usage_deposits: {
        Row: {
          amount_neuron: string;
          block_number: string;
          created_at: string;
          id: string;
          log_index: number;
          reference: string | null;
          status: "credited" | "duplicate" | "rejected";
          tx_hash: string;
          wallet_address: string;
          wallet_user_id: string;
        };
        Insert: {
          amount_neuron: string;
          block_number: string;
          created_at?: string;
          id?: string;
          log_index: number;
          reference?: string | null;
          status?: "credited" | "duplicate" | "rejected";
          tx_hash: string;
          wallet_address: string;
          wallet_user_id: string;
        };
        Update: {
          amount_neuron?: string;
          block_number?: string;
          created_at?: string;
          id?: string;
          log_index?: number;
          reference?: string | null;
          status?: "credited" | "duplicate" | "rejected";
          tx_hash?: string;
          wallet_address?: string;
          wallet_user_id?: string;
        };
        Relationships: [];
      };
      langclaw_usage_reservations: {
        Row: {
          balance_after_reserve_neuron: string;
          balance_before_neuron: string;
          charged_neuron: string;
          completion_price_neuron: string;
          completion_tokens: number | null;
          created_at: string;
          estimated_completion_tokens: number;
          estimated_prompt_tokens: number;
          id: string;
          model: string;
          prompt_price_neuron: string;
          prompt_tokens: number | null;
          released_neuron: string;
          reserved_neuron: string;
          status:
            | "reserved"
            | "charged"
            | "estimated"
            | "refunded"
            | "failed_after_charge";
          topic: string | null;
          total_tokens: number | null;
          updated_at: string;
          wallet_address: string;
          wallet_user_id: string;
        };
        Insert: {
          balance_after_reserve_neuron: string;
          balance_before_neuron: string;
          charged_neuron?: string;
          completion_price_neuron: string;
          completion_tokens?: number | null;
          created_at?: string;
          estimated_completion_tokens: number;
          estimated_prompt_tokens: number;
          id: string;
          model: string;
          prompt_price_neuron: string;
          prompt_tokens?: number | null;
          released_neuron?: string;
          reserved_neuron: string;
          status?:
            | "reserved"
            | "charged"
            | "estimated"
            | "refunded"
            | "failed_after_charge";
          topic?: string | null;
          total_tokens?: number | null;
          updated_at?: string;
          wallet_address: string;
          wallet_user_id: string;
        };
        Update: {
          balance_after_reserve_neuron?: string;
          balance_before_neuron?: string;
          charged_neuron?: string;
          completion_price_neuron?: string;
          completion_tokens?: number | null;
          created_at?: string;
          estimated_completion_tokens?: number;
          estimated_prompt_tokens?: number;
          id?: string;
          model?: string;
          prompt_price_neuron?: string;
          prompt_tokens?: number | null;
          released_neuron?: string;
          reserved_neuron?: string;
          status?:
            | "reserved"
            | "charged"
            | "estimated"
            | "refunded"
            | "failed_after_charge";
          topic?: string | null;
          total_tokens?: number | null;
          updated_at?: string;
          wallet_address?: string;
          wallet_user_id?: string;
        };
        Relationships: [];
      };
      langclaw_usage_charges: {
        Row: {
          charged_neuron: string;
          completion_price_neuron: string;
          completion_tokens: number;
          created_at: string;
          id: string;
          model: string;
          prompt_price_neuron: string;
          prompt_tokens: number;
          released_neuron: string;
          reservation_id: string;
          reserved_neuron: string;
          status: "charged" | "estimated" | "refunded" | "failed_after_charge";
          topic: string | null;
          total_tokens: number;
          wallet_address: string;
          wallet_user_id: string;
        };
        Insert: {
          charged_neuron: string;
          completion_price_neuron: string;
          completion_tokens?: number;
          created_at?: string;
          id?: string;
          model: string;
          prompt_price_neuron: string;
          prompt_tokens?: number;
          released_neuron: string;
          reservation_id: string;
          reserved_neuron: string;
          status: "charged" | "estimated" | "refunded" | "failed_after_charge";
          topic?: string | null;
          total_tokens?: number;
          wallet_address: string;
          wallet_user_id: string;
        };
        Update: {
          charged_neuron?: string;
          completion_price_neuron?: string;
          completion_tokens?: number;
          created_at?: string;
          id?: string;
          model?: string;
          prompt_price_neuron?: string;
          prompt_tokens?: number;
          released_neuron?: string;
          reservation_id?: string;
          reserved_neuron?: string;
          status?: "charged" | "estimated" | "refunded" | "failed_after_charge";
          topic?: string | null;
          total_tokens?: number;
          wallet_address?: string;
          wallet_user_id?: string;
        };
        Relationships: [];
      };
      langclaw_usage_refunds: {
        Row: {
          amount_neuron: string;
          created_at: string;
          id: string;
          reason: string | null;
          reservation_id: string;
          wallet_address: string;
          wallet_user_id: string;
        };
        Insert: {
          amount_neuron: string;
          created_at?: string;
          id?: string;
          reason?: string | null;
          reservation_id: string;
          wallet_address: string;
          wallet_user_id: string;
        };
        Update: {
          amount_neuron?: string;
          created_at?: string;
          id?: string;
          reason?: string | null;
          reservation_id?: string;
          wallet_address?: string;
          wallet_user_id?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      langclaw_create_api_key: {
        Args: {
          p_key_hash: string;
          p_key_prefix: string;
          p_key_suffix: string;
          p_name: string;
          p_wallet_user_id: string;
        };
        Returns: Database["public"]["Tables"]["langclaw_api_keys"]["Row"];
      };
      langclaw_usage_credit_deposit: {
        Args: {
          p_amount_neuron: string;
          p_block_number: string;
          p_log_index: number;
          p_reference: string | null;
          p_tx_hash: string;
          p_wallet_address: string;
          p_wallet_user_id: string;
        };
        Returns: {
          balance_after_neuron: string;
          balance_before_neuron: string;
          credited: boolean;
        }[];
      };
      langclaw_usage_finalize_reservation: {
        Args: {
          p_charged_neuron: string;
          p_completion_tokens: number;
          p_prompt_tokens: number;
          p_reservation_id: string;
          p_status: string;
          p_topic: string;
          p_total_tokens: number;
        };
        Returns: {
          balance_after_neuron: string;
          charged_neuron: string;
          released_neuron: string;
          status: string;
        }[];
      };
      langclaw_usage_refund_reservation: {
        Args: {
          p_reason: string;
          p_reservation_id: string;
        };
        Returns: {
          balance_after_neuron: string;
          released_neuron: string;
        }[];
      };
      langclaw_usage_reserve_balance: {
        Args: {
          p_completion_price_neuron: string;
          p_estimated_completion_tokens: number;
          p_estimated_prompt_tokens: number;
          p_model: string;
          p_prompt_price_neuron: string;
          p_reservation_id: string;
          p_reserved_neuron: string;
          p_wallet_address: string;
          p_wallet_user_id: string;
        };
        Returns: {
          balance_after_neuron: string;
          balance_before_neuron: string;
          reservation_id: string;
          reserved_neuron: string;
        }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
