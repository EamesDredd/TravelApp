import type { MouseEvent, ReactNode } from 'react';
import type { AppLink } from '../lib/maps';
import { openMapLink } from '../lib/openApp';
import { useStore } from '../store';

/** A Google Maps / Amap link that opens the app on phones that have it. */
export function MapAppLink(props: { link: AppLink; className?: string; children: ReactNode; onClick?(e: MouseEvent): void }) {
  const preferApp = useStore((s) => s.settings.preferMapApps);
  return (
    <a
      className={props.className}
      href={props.link.web}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        props.onClick?.(e);
        openMapLink(e, props.link, preferApp);
      }}
    >
      {props.children}
    </a>
  );
}
