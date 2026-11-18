import icon from '../../../build/icon-128.png'

export function WindowBrand({ subtitle }: { subtitle: string }) {
  return (
    <div className="window-brand">
      <img src={icon} alt="" width={36} height={36} draggable={false} />
      <div>
        <div className="window-brand-name">Deskhand</div>
        <div className="window-brand-subtitle">{subtitle}</div>
      </div>
    </div>
  )
}
