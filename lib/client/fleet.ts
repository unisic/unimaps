/**
 * Client-side API hooks and types for Fleet & Brigades.
 */
import useSWR from "swr";
import type { VehicleFeatures } from "./types";

export interface VehicleCourseStop {
  symbol: string;
  name: string;
  scheduledTime: string;
  plannedTime: string;
  status: "passed" | "current" | "upcoming";
  distanceMeters?: number;
}

export interface VehicleCourseRecord {
  id: string;
  courseLoid?: number;
  lineName: string;
  direction: string;
  firstStopName: string;
  lastStopName: string;
  firstStopSymbol?: string;
  lastStopSymbol?: string;
  startTime: string;
  endTime: string;
  startSecs: number;
  endSecs: number;
  delaySec: number;
  stopsCount: number;
  status: "completed" | "in_progress" | "predicted";
  completedAt?: number;
  stops?: VehicleCourseStop[];
}

export interface PredictedNextCourse {
  lineName: string;
  direction: string;
  departureTime: string;
  departureSecs: number;
  fromStopName: string;
  fromStopSymbol?: string;
  pauseMinutes: number;
  confidence: "high" | "medium";
  probabilityLabel: string;
  reason: string;
}

export interface FleetVehicleDetail {
  sideNumber: string;
  operator: "MZK" | "KB";
  model: string;
  producer: string;
  year?: string;
  lengthCategory: "MINI" | "MIDI" | "MAXI" | "MEGA";
  fuelType: "diesel" | "electric" | "hydrogen" | "hybrid";
  features: VehicleFeatures;
  status: "active" | "depot";
  brigade: {
    id: string;
    label: string;
    mainLine: string;
  };
  currentCourse: (VehicleCourseRecord & {
    currentStopIndex: number;
    currentStopName: string;
    nextStopName: string | null;
    lat: number;
    lon: number;
    bearing: number | null;
    progressPct: number;
  }) | null;
  predictedNextCourse: PredictedNextCourse | null;
  todayCourses: VehicleCourseRecord[];
  lastSeenAt: number;
  lastKnownLocation: {
    lat: number;
    lon: number;
    name: string;
  } | null;
  stats: {
    totalCoursesToday: number;
    completedCoursesToday: number;
    estimatedKmToday: number;
    averageDelaySecs: number;
    punctualityPct: number;
  };
}

export interface FleetSummaryItem {
  sideNumber: string;
  operator: "MZK" | "KB";
  model: string;
  producer: string;
  year?: string;
  lengthCategory: "MINI" | "MIDI" | "MAXI" | "MEGA";
  fuelType: "diesel" | "electric" | "hydrogen" | "hybrid";
  status: "active" | "depot";
  brigadeId: string;
  lineName?: string;
  direction?: string;
  currentStopName?: string;
  nextStopName?: string;
  delaySec?: number;
  coursesCountToday: number;
  progressPct?: number;
  lat?: number;
  lon?: number;
  features: VehicleFeatures;
}

export interface FleetStats {
  totalFleet: number;
  activeCount: number;
  depotCount: number;
  electricCount: number;
  hydrogenCount: number;
  hybridCount: number;
  megaCount: number;
  averageDelaySec: number;
  onTimePercentage: number;
  activeLines: string[];
}

export interface FleetApiResponse {
  stats: FleetStats;
  count: number;
  vehicles: FleetSummaryItem[];
}

export interface VehicleDetailApiResponse {
  vehicle: FleetVehicleDetail;
}

const fetcher = async <T>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP error ${res.status}`);
  }
  return res.json() as Promise<T>;
};

export function useFleet(params?: {
  status?: string;
  propulsion?: string;
  line?: string;
  q?: string;
}) {
  const query = new URLSearchParams();
  if (params?.status && params.status !== "all") query.set("status", params.status);
  if (params?.propulsion && params.propulsion !== "all") query.set("propulsion", params.propulsion);
  if (params?.line && params.line !== "all") query.set("line", params.line);
  if (params?.q?.trim()) query.set("q", params.q.trim());

  const qs = query.toString();
  const url = `/api/fleet${qs ? `?${qs}` : ""}`;

  return useSWR<FleetApiResponse>(url, fetcher, {
    refreshInterval: 5000,
    revalidateOnFocus: true,
    dedupingInterval: 2500,
  });
}

export function useVehicleDetail(sideNumber: string | null) {
  const clean = sideNumber?.replace(/^#/, "").trim();
  const url = clean ? `/api/fleet/${encodeURIComponent(clean)}` : null;

  return useSWR<VehicleDetailApiResponse>(url, fetcher, {
    refreshInterval: 4000,
    revalidateOnFocus: true,
    dedupingInterval: 2000,
  });
}
