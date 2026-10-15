// Pure salary calculation. All money is handled in integer cents to avoid float drift.
export type Method = "hourly" | "daily" | "monthly";

export interface SalaryConfig {
  method: Method;
  rate: number;                 // currency units: per hour | per day | per month
  standardHoursPerDay: number;
  overtimeMultiplier: number;
  standardDaysPerMonth: number;
  latePenalty: number;          // currency units per late arrival
}

export interface DayRecord { date: string; minutes: number; late: boolean }

export interface SalaryInput {
  config: SalaryConfig;
  days: DayRecord[];            // one entry per work date (sessions already summed)
  bonus?: number;
  deductions?: number;
}

export interface SalaryResult {
  method: Method;
  hoursWorked: number;
  daysWorked: number;
  overtimeHours: number;
  lateCount: number;
  basePay: number;
  overtimePay: number;
  bonus: number;
  deductions: number;
  lateDeductions: number;
  netPay: number;
}

const toCents = (n: number) => Math.round(n * 100);
const fromCents = (c: number) => c / 100;
const round2 = (n: number) => Math.round(n * 100) / 100;

// Attendance credit for one day: full day >= 75% of standard hours, half day >= 37.5%.
export function dayCredit(minutes: number, standardHours: number): number {
  const h = minutes / 60;
  if (h >= standardHours * 0.75) return 1;
  if (h >= standardHours * 0.375) return 0.5;
  return 0;
}

export function calculateSalary({ config, days, bonus = 0, deductions = 0 }: SalaryInput): SalaryResult {
  const std = config.standardHoursPerDay;
  const rateC = toCents(config.rate);

  let totalMinutes = 0, daysWorked = 0, overtimeMinutes = 0, regularMinutes = 0, lateCount = 0;
  for (const d of days) {
    totalMinutes += d.minutes;
    daysWorked += dayCredit(d.minutes, std);
    const ot = Math.max(0, d.minutes - std * 60);
    overtimeMinutes += ot;
    regularMinutes += d.minutes - ot;
    if (d.late) lateCount++;
  }

  // Hourly-equivalent rate used for overtime under each method (in cents per hour)
  let hourlyC: number;
  let baseC: number;
  switch (config.method) {
    case "hourly":
      hourlyC = rateC;
      baseC = Math.round((regularMinutes / 60) * rateC);
      break;
    case "daily":
      hourlyC = rateC / std;
      baseC = Math.round(daysWorked * rateC);
      break;
    case "monthly":
      hourlyC = rateC / config.standardDaysPerMonth / std;
      // Pro-rata on credited days, never more than the full monthly salary.
      baseC = Math.round(rateC * Math.min(1, daysWorked / config.standardDaysPerMonth));
      break;
  }
  const overtimeC = Math.round((overtimeMinutes / 60) * hourlyC * config.overtimeMultiplier);
  const lateC = lateCount * toCents(config.latePenalty);
  const bonusC = toCents(bonus);
  const dedC = toCents(deductions);
  const netC = Math.max(0, baseC + overtimeC + bonusC - dedC - lateC);

  return {
    method: config.method,
    hoursWorked: round2(totalMinutes / 60),
    daysWorked,
    overtimeHours: round2(overtimeMinutes / 60),
    lateCount,
    basePay: fromCents(baseC),
    overtimePay: fromCents(overtimeC),
    bonus: fromCents(bonusC),
    deductions: fromCents(dedC),
    lateDeductions: fromCents(lateC),
    netPay: fromCents(netC),
  };
}
