// Icon geometry copied from lucide (ISC License) — lucide-react v0.577.0.
// Kept inline so this package carries no external UI dependency.
import * as React from "react";
import type { SVGProps } from "react";

type IconNode = readonly (readonly [tag: string, attrs: Readonly<Record<string, string | number>>])[];

function createIcon(name: string, node: IconNode) {
  const Component = ({ size = 24, strokeWidth = 2, ...props }: SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number }) => (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {node.map(([tag, attrs], index) => React.createElement(tag, { ...attrs, key: index }))}
    </svg>
  );
  Component.displayName = name;
  return Component;
}

const SearchNode = [ ["path", { d: "m21 21-4.34-4.34", key: "14j7rj" }], ["circle", { cx: "11", cy: "11", r: "8", key: "4ej97u" }] ] as const;
export const Search = createIcon("Search", SearchNode);

const CarFrontNode = [ [ "path", { d: "m21 8-2 2-1.5-3.7A2 2 0 0 0 15.646 5H8.4a2 2 0 0 0-1.903 1.257L5 10 3 8", key: "1imjwt" } ], ["path", { d: "M7 14h.01", key: "1qa3f1" }], ["path", { d: "M17 14h.01", key: "7oqj8z" }], ["rect", { width: "18", height: "8", x: "3", y: "10", rx: "2", key: "a7itu8" }], ["path", { d: "M5 18v2", key: "ppbyun" }], ["path", { d: "M19 18v2", key: "gy7782" }] ] as const;
export const CarFront = createIcon("CarFront", CarFrontNode);

const BikeNode = [ ["circle", { cx: "18.5", cy: "17.5", r: "3.5", key: "15x4ox" }], ["circle", { cx: "5.5", cy: "17.5", r: "3.5", key: "1noe27" }], ["circle", { cx: "15", cy: "5", r: "1", key: "19l28e" }], ["path", { d: "M12 17.5V14l-3-3 4-3 2 3h2", key: "1npguv" }] ] as const;
export const Bike = createIcon("Bike", BikeNode);

const PersonStandingNode = [ ["circle", { cx: "12", cy: "5", r: "1", key: "gxeob9" }], ["path", { d: "m9 20 3-6 3 6", key: "se2kox" }], ["path", { d: "m6 8 6 2 6-2", key: "4o3us4" }], ["path", { d: "M12 10v4", key: "1kjpxc" }] ] as const;
export const PersonStanding = createIcon("PersonStanding", PersonStandingNode);

const BotNode = [ ["path", { d: "M12 8V4H8", key: "hb8ula" }], ["rect", { width: "16", height: "12", x: "4", y: "8", rx: "2", key: "enze0r" }], ["path", { d: "M2 14h2", key: "vft8re" }], ["path", { d: "M20 14h2", key: "4cs60a" }], ["path", { d: "M15 13v2", key: "1xurst" }], ["path", { d: "M9 13v2", key: "rq6x2g" }] ] as const;
export const Bot = createIcon("Bot", BotNode);

const PlaneNode = [ [ "path", { d: "M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z", key: "1v9wt8" } ] ] as const;
export const Plane = createIcon("Plane", PlaneNode);

const BirdNode = [ ["path", { d: "M16 7h.01", key: "1kdx03" }], ["path", { d: "M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20", key: "oj1oa8" }], ["path", { d: "m20 7 2 .5-2 .5", key: "12nv4d" }], ["path", { d: "M10 18v3", key: "1yea0a" }], ["path", { d: "M14 17.75V21", key: "1pymcb" }], ["path", { d: "M7 18a6 6 0 0 0 3.84-10.61", key: "1npnn0" }] ] as const;
export const Bird = createIcon("Bird", BirdNode);

const BoxNode = [ [ "path", { d: "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z", key: "hh9hay" } ], ["path", { d: "m3.3 7 8.7 5 8.7-5", key: "g66t2b" }], ["path", { d: "M12 22V12", key: "d0xqtd" }] ] as const;
export const Box = createIcon("Box", BoxNode);

const ImagesNode = [ ["path", { d: "m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16", key: "9kzy35" }], ["path", { d: "M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2", key: "1t0f0t" }], ["circle", { cx: "13", cy: "7", r: "1", fill: "currentColor", key: "1obus6" }], ["rect", { x: "8", y: "2", width: "14", height: "14", rx: "2", key: "1gvhby" }] ] as const;
export const Images = createIcon("Images", ImagesNode);

const CloudSunNode = [ ["path", { d: "M12 2v2", key: "tus03m" }], ["path", { d: "m4.93 4.93 1.41 1.41", key: "149t6j" }], ["path", { d: "M20 12h2", key: "1q8mjw" }], ["path", { d: "m19.07 4.93-1.41 1.41", key: "1shlcs" }], ["path", { d: "M15.947 12.65a4 4 0 0 0-5.925-4.128", key: "dpwdj0" }], ["path", { d: "M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z", key: "s09mg5" }] ] as const;
export const CloudSun = createIcon("CloudSun", CloudSunNode);

const RouteNode = [ ["circle", { cx: "6", cy: "19", r: "3", key: "1kj8tv" }], ["path", { d: "M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15", key: "1d8sl" }], ["circle", { cx: "18", cy: "5", r: "3", key: "gq8acd" }] ] as const;
export const Route = createIcon("Route", RouteNode);

const SquareParkingNode = [ ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }], ["path", { d: "M9 17V7h4a3 3 0 0 1 0 6H9", key: "1dfk2c" }] ] as const;
export const SquareParking = createIcon("SquareParking", SquareParkingNode);

const XNode = [ ["path", { d: "M18 6 6 18", key: "1bl5f8" }], ["path", { d: "m6 6 12 12", key: "d8bk6v" }] ] as const;
export const X = createIcon("X", XNode);

const ShuffleNode = [ ["path", { d: "m18 14 4 4-4 4", key: "10pe0f" }], ["path", { d: "m18 2 4 4-4 4", key: "pucp1d" }], ["path", { d: "M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22", key: "1ailkh" }], ["path", { d: "M2 6h1.972a4 4 0 0 1 3.6 2.2", key: "km57vx" }], ["path", { d: "M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45", key: "os18l9" }] ] as const;
export const Shuffle = createIcon("Shuffle", ShuffleNode);

const Clock3Node = [ ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }], ["path", { d: "M12 6v6h4", key: "135r8i" }] ] as const;
export const Clock3 = createIcon("Clock3", Clock3Node);

const SlidersHorizontalNode = [ ["path", { d: "M10 5H3", key: "1qgfaw" }], ["path", { d: "M12 19H3", key: "yhmn1j" }], ["path", { d: "M14 3v4", key: "1sua03" }], ["path", { d: "M16 17v4", key: "1q0r14" }], ["path", { d: "M21 12h-9", key: "1o4lsq" }], ["path", { d: "M21 19h-5", key: "1rlt1p" }], ["path", { d: "M21 5h-7", key: "1oszz2" }], ["path", { d: "M8 10v4", key: "tgpxqk" }], ["path", { d: "M8 12H3", key: "a7s4jb" }] ] as const;
export const SlidersHorizontal = createIcon("SlidersHorizontal", SlidersHorizontalNode);

const PlayNode = [ [ "path", { d: "M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z", key: "10ikf1" } ] ] as const;
export const Play = createIcon("Play", PlayNode);

const SquareNode = [ ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }] ] as const;
export const Square = createIcon("Square", SquareNode);

const RotateCcwNode = [ ["path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", key: "1357e3" }], ["path", { d: "M3 3v5h5", key: "1xhq8a" }] ] as const;
export const RotateCcw = createIcon("RotateCcw", RotateCcwNode);

const Trash2Node = [ ["path", { d: "M10 11v6", key: "nco0om" }], ["path", { d: "M14 11v6", key: "outv1u" }], ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", key: "miytrc" }], ["path", { d: "M3 6h18", key: "d0wm0j" }], ["path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", key: "e791ji" }] ] as const;
export const Trash2 = createIcon("Trash2", Trash2Node);

const TrafficConeNode = [ ["path", { d: "M16.05 10.966a5 2.5 0 0 1-8.1 0", key: "m5jpwb" }], [ "path", { d: "m16.923 14.049 4.48 2.04a1 1 0 0 1 .001 1.831l-8.574 3.9a2 2 0 0 1-1.66 0l-8.574-3.91a1 1 0 0 1 0-1.83l4.484-2.04", key: "rbg3g8" } ], ["path", { d: "M16.949 14.14a5 2.5 0 1 1-9.9 0L10.063 3.5a2 2 0 0 1 3.874 0z", key: "vap8c8" }], ["path", { d: "M9.194 6.57a5 2.5 0 0 0 5.61 0", key: "15hn5c" }] ] as const;
export const TrafficCone = createIcon("TrafficCone", TrafficConeNode);

const Globe2Node = [ ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }], ["path", { d: "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", key: "13o1zl" }], ["path", { d: "M2 12h20", key: "9i4pu4" }] ] as const;
export const Globe2 = createIcon("Globe2", Globe2Node);

const BrainCircuitNode = [ [ "path", { d: "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z", key: "l5xja" } ], ["path", { d: "M9 13a4.5 4.5 0 0 0 3-4", key: "10igwf" }], ["path", { d: "M6.003 5.125A3 3 0 0 0 6.401 6.5", key: "105sqy" }], ["path", { d: "M3.477 10.896a4 4 0 0 1 .585-.396", key: "ql3yin" }], ["path", { d: "M6 18a4 4 0 0 1-1.967-.516", key: "2e4loj" }], ["path", { d: "M12 13h4", key: "1ku699" }], ["path", { d: "M12 18h6a2 2 0 0 1 2 2v1", key: "105ag5" }], ["path", { d: "M12 8h8", key: "1lhi5i" }], ["path", { d: "M16 8V5a2 2 0 0 1 2-2", key: "u6izg6" }], ["circle", { cx: "16", cy: "13", r: ".5", key: "ry7gng" }], ["circle", { cx: "18", cy: "3", r: ".5", key: "1aiba7" }], ["circle", { cx: "20", cy: "21", r: ".5", key: "yhc1fs" }], ["circle", { cx: "20", cy: "8", r: ".5", key: "1e43v0" }] ] as const;
export const BrainCircuit = createIcon("BrainCircuit", BrainCircuitNode);

const AlertTriangleNode = [ [ "path", { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", key: "wmoenq" } ], ["path", { d: "M12 9v4", key: "juzpu7" }], ["path", { d: "M12 17h.01", key: "p32p05" }] ] as const;
export const AlertTriangle = createIcon("AlertTriangle", AlertTriangleNode);

const LockNode = [ ["rect", { width: "18", height: "11", x: "3", y: "11", rx: "2", ry: "2", key: "1w4ew1" }], ["path", { d: "M7 11V7a5 5 0 0 1 10 0v4", key: "fwvmzm" }] ] as const;
export const Lock = createIcon("Lock", LockNode);

const ZapNode = [ [ "path", { d: "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z", key: "1xq2db" } ] ] as const;
export const Zap = createIcon("Zap", ZapNode);

const PlusNode = [ ["path", { d: "M5 12h14", key: "1ays0h" }], ["path", { d: "M12 5v14", key: "s699le" }] ] as const;
export const Plus = createIcon("Plus", PlusNode);
