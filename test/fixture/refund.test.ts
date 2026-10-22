import { afterAll, it } from "vitest";
import { close, refund } from "./payments.ts";

afterAll(close);

it("refunds an invoice", refund);
