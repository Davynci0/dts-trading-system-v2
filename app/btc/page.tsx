import type { Metadata } from "next";
import BtcDashboard from "@/components/BtcDashboard";

export const metadata: Metadata = {
  title: "DTS — Bitcoin",
  description: "The Bitcoin system: a range breakout with the daily trend on the 4-hour chart. Read here only — it does not send signals.",
};

export default function BtcPage() {
  return <BtcDashboard />;
}
