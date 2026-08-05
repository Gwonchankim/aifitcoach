"use client";

/**
 * 오프라인 상태(UX_STATES §1.1). SSR·첫 렌더는 온라인으로 가정해 하이드레이션 불일치를 피하고,
 * 마운트 직후 실제 값으로 맞춘다.
 */
import { useEffect, useState } from "react";

export function useOnline(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return online;
}

/** 오프라인 배지에 함께 붙이는 기준 시각(AC-S3-3). */
export function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  return `${hours}:${minutes}`;
}
