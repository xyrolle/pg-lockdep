import { afterAll, it } from "vitest";
import { audit, close, pay } from "./payments.ts";

afterAll(close);

it("pays an invoice", pay);

it("audits the accounts", audit);
