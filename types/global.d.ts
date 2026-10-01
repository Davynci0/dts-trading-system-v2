/** Global chart-capture hook registered by components/Chart.tsx (Ask AI uses it). */
declare global {
  interface Window {
    __dtsChartCapture?: () => string | null;
  }
}

export {};
