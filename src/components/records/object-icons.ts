import { Box, Briefcase, Building2, Calendar, File, Flag, Folder, Heart, Star, Tag, Users, Wrench, type LucideIcon } from "lucide-react";
import type { ObjectIcon } from "../../../convex/lib/objects/registry";

/** The icons an admin can give a custom object (registry.ts OBJECT_ICONS). */
export const OBJECT_ICON_COMPONENTS: Readonly<Record<ObjectIcon, LucideIcon>> = {
  folder: Folder, briefcase: Briefcase, box: Box, calendar: Calendar, flag: Flag, star: Star, heart: Heart,
  file: File, users: Users, building: Building2, tag: Tag, wrench: Wrench,
};

export const objectIcon = (name: string | null | undefined): LucideIcon =>
  (name && Object.hasOwn(OBJECT_ICON_COMPONENTS, name) ? OBJECT_ICON_COMPONENTS[name as ObjectIcon] : Folder);
