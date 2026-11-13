import type { ViewDef } from "../shell/views.js";
import { CompanyPage } from "./CompanyPage.js";

export const companyView: ViewDef<"company"> = { kind: "company", render: (view, ctx) => <CompanyPage view={view} {...ctx} /> };
