import React from "react";
import Svg, { Ellipse, Path } from "react-native-svg";

interface PinIconProps {
  fill: string;
  stroke: string;
  size?: number;
}

/**
 * Static 3D-style teardrop pin icon — same visual shape as MapPin3D but
 * rendered as a standalone inline SVG with no animation. Sized to slot in
 * wherever a small emoji-sized icon is expected.
 *
 * viewBox: 0 0 16 22  (cx=8, cy=20, r=5)
 */
export function PinIcon({ fill, stroke, size = 16 }: PinIconProps) {
  const w = size;
  const h = Math.round(size * 1.375);
  return (
    <Svg width={w} height={h} viewBox="0 0 16 22">
      <Ellipse cx="8" cy="20.9" rx="2.1" ry="0.8" fill="rgba(0,0,0,0.18)" />
      <Path
        d="M 8,20 C 6.1,17.25 3,14.5 3,10.75 A 5,5 0 1,1 13,10.75 C 13,14.5 9.9,17.25 8,20 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <Ellipse cx="6.6" cy="9.15" rx="1.05" ry="0.65" fill="rgba(255,255,255,0.55)" />
    </Svg>
  );
}
