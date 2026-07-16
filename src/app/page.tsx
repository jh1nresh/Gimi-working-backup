import { GimiAppShell } from "@/components/GimiAppShell";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ demo?: string | string[] }>;
}) {
  const { demo } = await searchParams;
  return <GimiAppShell partnerDemo={demo === "partner"} />;
}
