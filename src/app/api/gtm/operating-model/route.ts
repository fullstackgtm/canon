import { getGtmOperatingModel } from "../../../../lib/gtm-operating-model.ts";
import { publicGtmApi } from "../_lib.ts";

export const dynamic = "force-dynamic";

export const GET = publicGtmApi(() =>
  Response.json({ operatingModel: getGtmOperatingModel() }),
);
