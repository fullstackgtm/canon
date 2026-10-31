import "./marketing.css";
import { Header } from "@/components/marketing/header";
import { Footer } from "@/components/marketing/footer";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="marketing">
      <Header />
      <main>{children}</main>
      <Footer />
    </div>
  );
}
