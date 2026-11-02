import { TapToTalk } from "@/components/TapToTalk";

export const metadata = {
  title: "Vale debug — voice session controls",
};

/** Debug view: every control and list, out of the demo screens. */
export default function DebugPage() {
  return (
    <main>
      <h1>Vale debug</h1>
      <TapToTalk debug />
    </main>
  );
}
