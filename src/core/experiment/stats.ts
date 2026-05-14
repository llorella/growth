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
