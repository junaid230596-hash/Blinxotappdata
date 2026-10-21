import { describe, expect, it } from "vitest";
import { calculateSalary, dayCredit, type SalaryConfig } from "../server/src/modules/salary/salary.calc.js";

const cfg = (o: Partial<SalaryConfig> = {}): SalaryConfig => ({
  method: "hourly", rate: 100, standardHoursPerDay: 8, overtimeMultiplier: 1.5, standardDaysPerMonth: 26, latePenalty: 0, ...o,
});
const day = (date: string, hours: number, late = false) => ({ date, minutes: Math.round(hours * 60), late });

describe("dayCredit", () => {
  it("gives full/half/no credit by thresholds", () => {
    expect(dayCredit(8 * 60, 8)).toBe(1);
    expect(dayCredit(6 * 60, 8)).toBe(1);        // exactly 75%
    expect(dayCredit(5.9 * 60, 8)).toBe(0.5);
    expect(dayCredit(3 * 60, 8)).toBe(0.5);      // exactly 37.5%
    expect(dayCredit(2.9 * 60, 8)).toBe(0);
  });
});

describe("hourly", () => {
  it("pays regular hours at rate and overtime at multiplier", () => {
    const r = calculateSalary({ config: cfg(), days: [day("2026-09-01", 10), day("2026-09-02", 8)] });
    expect(r.hoursWorked).toBe(18);
    expect(r.overtimeHours).toBe(2);
    expect(r.basePay).toBe(1600);       // 16 regular h * 100
    expect(r.overtimePay).toBe(300);    // 2h * 100 * 1.5
    expect(r.netPay).toBe(1900);
  });
});

describe("daily", () => {
  it("pays credited days and overtime beyond standard hours", () => {
    const r = calculateSalary({ config: cfg({ method: "daily", rate: 800 }), days: [day("d1", 8), day("d2", 4), day("d3", 1), day("d4", 9)] });
    expect(r.daysWorked).toBe(2.5);     // 1 + 0.5 + 0 + 1
    expect(r.basePay).toBe(2000);
    expect(r.overtimeHours).toBe(1);
    expect(r.overtimePay).toBe(150);    // (800/8)=100/h * 1h * 1.5
  });
});

describe("monthly", () => {
  it("pays pro-rata on credited days and caps at the full salary", () => {
    const c = cfg({ method: "monthly", rate: 26000 });
    const half = calculateSalary({ config: c, days: Array.from({ length: 13 }, (_, i) => day(`d${i}`, 8)) });
    expect(half.basePay).toBe(13000);
    const over = calculateSalary({ config: c, days: Array.from({ length: 30 }, (_, i) => day(`d${i}`, 8)) });
    expect(over.basePay).toBe(26000);
  });
  it("derives overtime from an hourly equivalent", () => {
    const r = calculateSalary({ config: cfg({ method: "monthly", rate: 20800, standardDaysPerMonth: 26 }), days: [day("d1", 10)] });
    expect(r.overtimePay).toBe(300);    // 20800/26/8 = 100/h * 2h * 1.5
  });
});

describe("adjustments", () => {
  it("applies bonus, deductions and late penalties; never goes negative", () => {
    const c = cfg({ method: "daily", rate: 1000, latePenalty: 50 });
    const r = calculateSalary({ config: c, days: [day("d1", 8, true), day("d2", 8, true), day("d3", 8)], bonus: 500, deductions: 200 });
    expect(r.lateCount).toBe(2);
    expect(r.lateDeductions).toBe(100);
    expect(r.netPay).toBe(3000 + 500 - 200 - 100);
    const neg = calculateSalary({ config: c, days: [day("d1", 8)], deductions: 99999 });
    expect(neg.netPay).toBe(0);
  });
  it("is exact with fractional rates (no float drift)", () => {
    const r = calculateSalary({ config: cfg({ rate: 33.33 }), days: [day("d1", 3)] });
    expect(r.basePay).toBe(99.99);
  });
  it("handles an empty period", () => {
    const r = calculateSalary({ config: cfg(), days: [] });
    expect(r.netPay).toBe(0);
    expect(r.hoursWorked).toBe(0);
  });
});
