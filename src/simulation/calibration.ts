export interface SimulationCalibration {
  readonly version: string;
  readonly midpoint: number;
  readonly slope: number;
}

export function calibrateSimulation(latent: number, calibration: SimulationCalibration) {
  const { version, midpoint, slope } = calibration;
  if (!Number.isFinite(latent) || !Number.isFinite(midpoint) || !Number.isFinite(slope)
    || slope <= 0 || version.trim() === "") return null;
  const score = 100 / (1 + Math.exp(-slope * (latent - midpoint)));
  return { latent, score, displayScore: score.toFixed(1), calibrationVersion: version };
}
