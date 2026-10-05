import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { Link2Off, Smartphone } from "lucide-react";
import { getSharedOptions } from "@/api";
import { useApi } from "@/hooks/useApi";
import { useIsMobile } from "@/hooks/useIsMobile";
import { SharedOptionsProvider } from "@/context/SharedOptionsContext";
import { BeaconLoader } from "@/components/BeaconLoader";
import { OptionsTrading } from "@/pages/OptionsTrading";

function Notice({ icon: Icon, title, body }: { icon: typeof Smartphone; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <Icon className="mb-4 h-10 w-10 text-muted-foreground" />
      <h2 className="tp-panel-title">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function SharedOptionsBody({ token }: { token: string }) {
  const { data, error } = useApi(() => getSharedOptions(token), [token]);
  if (error) {
    return (
      <Notice
        icon={Link2Off}
        title="Link unavailable"
        body="This share link is no longer active. Ask the owner for a new one."
      />
    );
  }
  if (!data) return <BeaconLoader />;
  return (
    <SharedOptionsProvider value={{ token, data }}>
      <OptionsTrading />
    </SharedOptionsProvider>
  );
}

/**
 * Public, read-only view of the Options Trading page (/share/options/:token).
 * Sits outside RequireAuth and the app Layout: the bar carries the logo and
 * nothing else, so there is no way from here into the rest of the site.
 */
export function SharedOptions() {
  const { token = "" } = useParams();
  const isMobile = useIsMobile();

  // The token is in the URL — keep the page out of search indexes and the URL
  // out of Referer headers. (The server sets the same as response headers in
  // production; these cover the dev server.)
  useEffect(() => {
    const metas = [
      ["robots", "noindex, nofollow"],
      ["referrer", "no-referrer"],
    ].map(([name, content]) => {
      const el = document.createElement("meta");
      el.name = name;
      el.content = content;
      document.head.appendChild(el);
      return el;
    });
    return () => metas.forEach((el) => el.remove());
  }, []);

  return (
    <div className="min-h-screen pt-4">
      <header className="sticky top-4 z-50 mx-auto max-w-7xl px-2">
        <div className="flex h-14 items-center rounded-xl border border-border bg-card px-4 backdrop-blur-[22px] backdrop-saturate-[140%] shadow-card">
          <img src="/beacon-logo.png" alt="Beacon" width={92} height={26} />
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-4 md:p-6">
        {isMobile ? (
          <Notice icon={Smartphone} title="Not available on phones" body="Open this link on a larger screen to view it." />
        ) : (
          <SharedOptionsBody token={token} />
        )}
      </main>
    </div>
  );
}
