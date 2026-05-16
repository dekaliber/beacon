// 5 equal circles (30×30px) orbiting clockwise through the logo layout.
// Keyframes beacon-c0…c4 are defined in index.css.
const CIRCLES = [
  { color: "#FFC533", anim: "beacon-c0" },
  { color: "#F5AF00", anim: "beacon-c1" },
  { color: "#B88400", anim: "beacon-c2" },
  { color: "#B88400", anim: "beacon-c3" },
  { color: "#F5AF00", anim: "beacon-c4" },
];

interface BeaconLoaderProps {
  className?: string;
}

const DOT_DELAYS = ["0s", "0.4s", "0.8s"];

export function BeaconLoader({ className = "flex-1 min-h-[16rem]" }: BeaconLoaderProps) {
  return (
    <div className={`flex flex-col items-center justify-center gap-4 ${className}`}>
      <div className="relative" style={{ width: 60, height: 90 }}>
        {CIRCLES.map((c, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              width: 30,
              height: 30,
              borderRadius: "50%",
              backgroundColor: c.color,
              animation: `${c.anim} 3.5s linear infinite`,
            }}
          />
        ))}
      </div>
      <div className="flex items-end text-sm text-muted-foreground">
        <span>Loading</span>
        {DOT_DELAYS.map((delay, i) => (
          <span
            key={i}
            style={{ animation: "beacon-dot 1.2s ease-in-out infinite", animationDelay: delay }}
          >.</span>
        ))}
      </div>
    </div>
  );
}
