import { TapToTalk } from "@/components/TapToTalk";
import { NailPhoto } from "@/components/NailPhoto";

export default function Home() {
  return (
    <main>
      <h1>Vale</h1>
      <p>
        Your hands-free helper. Tap the button, allow the microphone, and just
        talk.
      </p>
      <TapToTalk />
      <NailPhoto />
    </main>
  );
}
