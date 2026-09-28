import {
  LayoutDashboard,
  ListFilter,
  Eye,
  Clock,
  Inbox,
  Settings2,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const navGroups: NavGroup[] = [
  {
    label: "Overview",
    items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Organize",
    items: [
      { to: "/rules", label: "Rules", icon: ListFilter },
      { to: "/preview", label: "Preview", icon: Eye },
      { to: "/unsorted", label: "Unsorted", icon: Inbox },
    ],
  },
  {
    label: "Activity",
    items: [{ to: "/history", label: "History", icon: Clock }],
  },
];

export const settingsNavItem: NavItem = {
  to: "/settings",
  label: "Settings",
  icon: Settings2,
};

const allItems = [...navGroups.flatMap((g) => g.items), settingsNavItem];

/** Resolve the current route to a page label for the title bar. */
export function pageLabelForPath(pathname: string): string {
  // Longest-matching "to" prefix wins so nested routes (e.g. /rules/new)
  // still resolve to their parent nav item's label.
  let best: NavItem | null = null;
  for (const item of allItems) {
    const matches =
      item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
    if (matches && (!best || item.to.length > best.to.length)) {
      best = item;
    }
  }
  return best?.label ?? "FileFlow";
}
