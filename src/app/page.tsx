import { TapToTalk } from "@/components/TapToTalk";

export default function Home() {
  return (
    <main>
      <h1>Vale</h1>
      <p>
        Your hands-free helper. Tap the button, allow the microphone, and just
        talk.
      </p>
      <TapToTalk />
    </main>
  );
}
