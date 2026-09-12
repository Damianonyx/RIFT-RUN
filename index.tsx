import { createFileRoute } from "@tanstack/react-router";
import { GameScreen } from "@/components/game/GameScreen";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <GameScreen />;
}
