import { useEffect } from "react";

import { RouteBoundary } from "./components/RouteBoundary";
import { NAV, Shell } from "./components/Shell";
import { Empty } from "./components/ui";
import { useRoute } from "./hooks";
import { AttackLibrary } from "./pages/AttackLibrary";
import { AuditTrail } from "./pages/AuditTrail";
import { Demo } from "./pages/Demo";
import { HowItWorks } from "./pages/HowItWorks";
import { IsolationLab } from "./pages/IsolationLab";
import { Overview } from "./pages/Overview";
import { Reports } from "./pages/Reports";
import { Runs } from "./pages/Runs";

function NotFound() {
  return (
    <Empty>
      Nothing lives at this address. <a href="#/" className="text-bone-50 underline decoration-ink-500 underline-offset-4">Go to the overview</a>.
    </Empty>
  );
}

function Page({ page, id }: { page: string; id?: string }) {
  switch (page) {
    case "":
      return <Overview />;
    case "how":
      return <HowItWorks />;
    case "demo":
      return <Demo />;
    case "runs":
      return <Runs id={id} />;
    case "attacks":
      return <AttackLibrary />;
    case "isolation":
      return <IsolationLab />;
    case "audit":
      return <AuditTrail />;
    case "reports":
      return <Reports id={id} />;
    case "dev-crash":
      // Development-only route for checking the error boundary; compiled out of production builds.
      if (import.meta.env.DEV) throw new Error("Deliberate render error from the dev-only #/dev-crash route");
      return <NotFound />;
    default:
      return <NotFound />;
  }
}

export function App() {
  const [page = "", id] = useRoute();

  useEffect(() => {
    window.scrollTo(0, 0);
    const label = NAV.find((item) => item.path === page)?.label;
    document.title = label && page ? `${label} · Bayora` : "Bayora";
  }, [page, id]);

  return (
    <Shell active={page}>
      <div key={`${page}/${id ?? ""}`} className="route">
        <RouteBoundary>
          <Page page={page} id={id} />
        </RouteBoundary>
      </div>
    </Shell>
  );
}
