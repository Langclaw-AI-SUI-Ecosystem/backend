import type { AutomationFrequency, AutomationTriggerType } from "./types";

const weekdayLabels = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

type NextRunInput = {
  frequency: AutomationFrequency;
  scheduleTime: string;
  scheduleWeekday?: number;
  scheduleMonthDay?: number;
  timezone?: string;
  from?: Date;
};

type TriggerLabelInput = {
  triggerType: AutomationTriggerType;
  scheduleFrequency?: AutomationFrequency;
  scheduleTime?: string;
  scheduleWeekday?: number;
  scheduleMonthDay?: number;
  eventName?: string;
};

type ZonedParts = {
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  weekday: number;
  year: number;
};

export function computeNextRunAt({
  frequency,
  from = new Date(),
  scheduleMonthDay,
  scheduleTime,
  scheduleWeekday,
  timezone = "Asia/Jakarta",
}: NextRunInput) {
  const [hour, minute] = parseScheduleTime(scheduleTime);
  const current = getZonedParts(from, timezone);
  let candidateParts: Omit<ZonedParts, "second" | "weekday"> = {
    day: current.day,
    hour,
    minute,
    month: current.month,
    year: current.year,
  };

  if (frequency === "weekly") {
    const targetWeekday = normalizeWeekday(scheduleWeekday ?? current.weekday);
    let daysToAdd = (targetWeekday - current.weekday + 7) % 7;
    candidateParts = addLocalDays(
      {
        day: current.day,
        month: current.month,
        year: current.year,
      },
      daysToAdd,
      hour,
      minute
    );

    if (zonedTimeToUtc(candidateParts, timezone).getTime() <= from.getTime()) {
      daysToAdd += 7;
      candidateParts = addLocalDays(
        {
          day: current.day,
          month: current.month,
          year: current.year,
        },
        daysToAdd,
        hour,
        minute
      );
    }

    return zonedTimeToUtc(candidateParts, timezone).toISOString();
  }

  if (frequency === "monthly") {
    const targetDay = clampMonthDay(scheduleMonthDay ?? current.day);
    candidateParts = buildMonthCandidate(
      current.year,
      current.month,
      targetDay,
      hour,
      minute
    );

    if (zonedTimeToUtc(candidateParts, timezone).getTime() <= from.getTime()) {
      const nextMonth = current.month === 12 ? 1 : current.month + 1;
      const nextYear = current.month === 12 ? current.year + 1 : current.year;
      candidateParts = buildMonthCandidate(
        nextYear,
        nextMonth,
        targetDay,
        hour,
        minute
      );
    }

    return zonedTimeToUtc(candidateParts, timezone).toISOString();
  }

  if (zonedTimeToUtc(candidateParts, timezone).getTime() <= from.getTime()) {
    candidateParts = addLocalDays(
      {
        day: current.day,
        month: current.month,
        year: current.year,
      },
      1,
      hour,
      minute
    );
  }

  return zonedTimeToUtc(candidateParts, timezone).toISOString();
}

export function buildTriggerLabel({
  eventName,
  scheduleFrequency,
  scheduleMonthDay,
  scheduleTime = "09:00",
  scheduleWeekday,
  triggerType,
}: TriggerLabelInput) {
  if (triggerType === "event") {
    return eventName ? `After ${eventName}` : "Event trigger";
  }

  if (triggerType === "webhook") {
    return "Webhook trigger";
  }

  if (scheduleFrequency === "weekly") {
    const day = weekdayLabels[normalizeWeekday(scheduleWeekday ?? 1)];

    return `Every ${day} at ${scheduleTime}`;
  }

  if (scheduleFrequency === "monthly") {
    const day = clampMonthDay(scheduleMonthDay ?? 1);

    return `Every month on day ${day} at ${scheduleTime}`;
  }

  return `Every day at ${scheduleTime}`;
}

export function parseScheduleTime(value: string) {
  if (!/^[0-2][0-9]:[0-5][0-9]$/.test(value)) {
    return [9, 0] as const;
  }

  const [rawHour, rawMinute] = value.split(":");
  const hour = Math.min(Number(rawHour), 23);
  const minute = Number(rawMinute);

  return [hour, minute] as const;
}

export function normalizeWeekday(value: number) {
  if (!Number.isInteger(value)) {
    return 1;
  }

  return ((value % 7) + 7) % 7;
}

export function clampMonthDay(value: number) {
  if (!Number.isInteger(value)) {
    return 1;
  }

  return Math.min(Math.max(value, 1), 31);
}

export function getZonedParts(date: Date, timezone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );

  return {
    day: Number(parts.day),
    hour: normalizeFormattedHour(Number(parts.hour)),
    minute: Number(parts.minute),
    month: Number(parts.month),
    second: Number(parts.second),
    weekday: weekdayLabels.findIndex((label) =>
      label.startsWith(String(parts.weekday))
    ),
    year: Number(parts.year),
  };
}

function addLocalDays(
  date: Pick<ZonedParts, "day" | "month" | "year">,
  days: number,
  hour: number,
  minute: number
) {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));

  return {
    day: next.getUTCDate(),
    hour,
    minute,
    month: next.getUTCMonth() + 1,
    year: next.getUTCFullYear(),
  };
}

function buildMonthCandidate(
  year: number,
  month: number,
  targetDay: number,
  hour: number,
  minute: number
) {
  const day = Math.min(targetDay, daysInMonth(year, month));

  return {
    day,
    hour,
    minute,
    month,
    year,
  };
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function zonedTimeToUtc(
  parts: Omit<ZonedParts, "second" | "weekday">,
  timezone: string
) {
  const utcGuess = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  );
  const offset = getTimeZoneOffsetMs(utcGuess, timezone);

  return new Date(utcGuess.getTime() - offset);
}

function getTimeZoneOffsetMs(date: Date, timezone: string) {
  const parts = getZonedParts(date, timezone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  return asUtc - date.getTime();
}

function normalizeFormattedHour(hour: number) {
  return hour === 24 ? 0 : hour;
}
