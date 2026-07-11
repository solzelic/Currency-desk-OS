import { FormEvent, useState } from "react";
import type { Customer } from "../domain/types";
import { PanelTitle } from "./shared";

type NewCustomerInput = Pick<Customer, "name" | "phone" | "risk" | "idStatus">;

export function CustomerPanel({
  customers,
  selectedCustomer,
  selectedCustomerId,
  onSelectCustomer,
  onCreateCustomer
}: {
  customers: Customer[];
  selectedCustomer: Customer | undefined;
  selectedCustomerId: string;
  onSelectCustomer: (customerId: string) => void;
  onCreateCustomer: (input: NewCustomerInput) => void;
}) {
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerRisk, setCustomerRisk] = useState<Customer["risk"]>("Normal");
  const [customerIdStatus, setCustomerIdStatus] = useState<Customer["idStatus"]>("verified");

  function createCustomer(event: FormEvent) {
    event.preventDefault();
    if (!customerName.trim()) return;
    onCreateCustomer({
      name: customerName.trim(),
      phone: customerPhone.trim() || undefined,
      risk: customerRisk,
      idStatus: customerIdStatus
    });
    setCustomerName("");
    setCustomerPhone("");
    setCustomerRisk("Normal");
    setCustomerIdStatus("verified");
  }

  return (
    <section className="panel">
      <PanelTitle kicker="Customer" title="Select or create customer" />
      <label>
        Existing customer
        <select value={selectedCustomerId} onChange={(event) => onSelectCustomer(event.target.value)} data-testid="customer-select">
          <option value="">Select customer</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name} · {customer.risk} · {customer.idStatus}
            </option>
          ))}
        </select>
      </label>

      {selectedCustomer && (
        <div className="customer-card" data-testid="selected-customer">
          <strong>{selectedCustomer.name}</strong>
          <span>{selectedCustomer.risk} risk</span>
          <span>ID {selectedCustomer.idStatus}</span>
        </div>
      )}

      <form className="create-form" onSubmit={createCustomer}>
        <label>
          New customer name
          <input
            value={customerName}
            onChange={(event) => setCustomerName(event.target.value)}
            placeholder="Customer or business name"
            data-testid="new-customer-name"
          />
        </label>
        <label>
          Phone
          <input value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} placeholder="Optional" />
        </label>
        <div className="two-col">
          <label>
            Risk
            <select value={customerRisk} onChange={(event) => setCustomerRisk(event.target.value as Customer["risk"])}>
              {["Low", "Normal", "Medium", "High"].map((risk) => (
                <option key={risk}>{risk}</option>
              ))}
            </select>
          </label>
          <label>
            ID status
            <select value={customerIdStatus} onChange={(event) => setCustomerIdStatus(event.target.value as Customer["idStatus"])}>
              <option value="verified">Verified</option>
              <option value="on-file">On file</option>
              <option value="missing">Missing</option>
              <option value="expired">Expired</option>
            </select>
          </label>
        </div>
        <button type="submit" className="secondary" data-testid="create-customer">
          Create customer
        </button>
      </form>
    </section>
  );
}
