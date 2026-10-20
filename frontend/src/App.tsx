import { useEffect } from "react";

import { NAV, Shell } from "./components/Shell";
import { Empty } from "./components/ui";
import { useRoute } from "./hooks";
import { AttackLibrary } from "./pages/AttackLibrary";
import { AuditTrail } from "./pages/AuditTrail";
import { IsolationLab } from "./pages/IsolationLab";
import { Overview } from "./pages/Overview";
import { Reports } from "./pages/Reports";
import { Runs } from "./pages/Runs";

function Page({ page, id }: { page: string; id?: string }) {
  switch (page) {
    case "":
      return <Overview />;
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
    default:
      return <Empty>Nothing lives at this address.</Empty>;
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
        <Page page={page} id={id} />
      </div>
    </Shell>
  );
}
