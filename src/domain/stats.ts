/**
 * Statistical engine: sample size, significance, confidence intervals.
 * Approximations are intentional - fast feedback for shipping decisions,
 * not academic precision.
 */

function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) throw new Error('p must be between 0 and 1');

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number, r: number;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
}

export function requiredSampleSize(
  baselineRate: number,
  minDetectableEffect: number,
  power = 0.8,
  alpha = 0.05,
): number {
  if (baselineRate <= 0 || baselineRate >= 1) {
    throw new Error('baselineRate must be between 0 and 1');
  }
  const treatmentRate = baselineRate * (1 + minDetectableEffect);
  if (treatmentRate >= 1) throw new Error('treatment rate would exceed 100%');

  const pooled = (baselineRate + treatmentRate) / 2;
  const zAlpha = normalQuantile(1 - alpha / 2);
  const zBeta = normalQuantile(power);

  const numerator = 2 * pooled * (1 - pooled) * Math.pow(zAlpha + zBeta, 2);
  const denominator = Math.pow(treatmentRate - baselineRate, 2);
  return Math.ceil(numerator / denominator);
}

export interface ProportionSig {
  controlRate: number;
  treatmentRate: number;
  absoluteDiff: number;
  relativeLift: number;
  pValue: number;
  ci95: { lower: number; upper: number };
  status: 'significant' | 'not_significant' | 'insufficient_data';
}

export function proportionSignificance(
  controlN: number,
  controlSuccesses: number,
  treatmentN: number,
  treatmentSuccesses: number,
  alpha = 0.05,
  minPerVariant = 30,
): ProportionSig {
  const controlRate = controlN > 0 ? controlSuccesses / controlN : 0;
  const treatmentRate = treatmentN > 0 ? treatmentSuccesses / treatmentN : 0;
  const absoluteDiff = treatmentRate - controlRate;
  const relativeLift = controlRate > 0 ? absoluteDiff / controlRate : 0;

  if (controlN < minPerVariant || treatmentN < minPerVariant) {
    return {
      controlRate,
      treatmentRate,
      absoluteDiff,
      relativeLift,
      pValue: NaN,
      ci95: { lower: NaN, upper: NaN },
      status: 'insufficient_data',
    };
  }

  const pooled = (controlSuccesses + treatmentSuccesses) / (controlN + treatmentN);
  const sePooled = Math.sqrt(pooled * (1 - pooled) * (1 / controlN + 1 / treatmentN));
  const z = sePooled > 0 ? absoluteDiff / sePooled : 0;
  const pValue = 2 * (1 - normalCDF(Math.abs(z)));

  const seUnpooled = Math.sqrt(
    (controlRate * (1 - controlRate)) / controlN +
      (treatmentRate * (1 - treatmentRate)) / treatmentN,
  );
  const zCrit = normalQuantile(1 - alpha / 2);
  const moe = zCrit * seUnpooled;

  return {
    controlRate,
    treatmentRate,
    absoluteDiff,
    relativeLift,
    pValue,
    ci95: { lower: absoluteDiff - moe, upper: absoluteDiff + moe },
    status: pValue < alpha ? 'significant' : 'not_significant',
  };
}

export interface ContinuousSig {
  controlMean: number;
  treatmentMean: number;
  absoluteDiff: number;
  percentChange: number;
  pValue: number;
  ci95: { lower: number; upper: number };
  status: 'significant' | 'not_significant' | 'insufficient_data';
}

export function continuousSignificance(
  controlValues: number[],
  treatmentValues: number[],
  alpha = 0.05,
  minPerVariant = 30,
): ContinuousSig {
  const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const variance = (a: number[], m: number) =>
    a.length > 1 ? a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1) : 0;

  const cm = mean(controlValues);
  const tm = mean(treatmentValues);
  const absoluteDiff = tm - cm;
  const percentChange = cm !== 0 ? absoluteDiff / cm : 0;

  if (controlValues.length < minPerVariant || treatmentValues.length < minPerVariant) {
    return {
      controlMean: cm,
      treatmentMean: tm,
      absoluteDiff,
      percentChange,
      pValue: NaN,
      ci95: { lower: NaN, upper: NaN },
      status: 'insufficient_data',
    };
  }

  const cv = variance(controlValues, cm);
  const tv = variance(treatmentValues, tm);
  const se = Math.sqrt(cv / controlValues.length + tv / treatmentValues.length);
  const t = se > 0 ? absoluteDiff / se : 0;
  const pValue = 2 * (1 - normalCDF(Math.abs(t)));
  const zCrit = normalQuantile(1 - alpha / 2);
  const moe = zCrit * se;

  return {
    controlMean: cm,
    treatmentMean: tm,
    absoluteDiff,
    percentChange,
    pValue,
    ci95: { lower: absoluteDiff - moe, upper: absoluteDiff + moe },
    status: pValue < alpha ? 'significant' : 'not_significant',
  };
}
