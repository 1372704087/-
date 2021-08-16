#pragma once

#include <Utilities/SavegameDef.h>

#include <BuildingClass.h>

class FoggedObject
{
public:
	AbstractType CoveredRTTIType;
	CoordStruct Location;
	RectangleStruct Bound;
	bool Translucent;
	int Comparator;

public:
	FoggedObject(AbstractType rtti, CoordStruct& location, RectangleStruct& bound);
	FoggedObject(ObjectClass* pObject);
	FoggedObject() = default;

	virtual ~FoggedObject();
	virtual void Draw(RectangleStruct& rect) {}
	virtual int GetType();
	virtual BuildingTypeClass* GetBuildingType();
	virtual bool Load(PhobosStreamReader& Stm, bool RegisterForChange);
	virtual bool Save(PhobosStreamWriter& Stm) const;

	void InitComparator()
	{
		// Don't ask me why, WW did this - secsome
		auto PixelX = (__int16)(this->Location.X / 256);
		auto PixelY = (__int16)(this->Location.Y / 256);
		Comparator = 74 * (PixelY - ((PixelX + PixelY) << 9) - PixelX) - (int)this->CoveredRTTIType + 0x7FFFFFFF;
	}

	bool operator< (const FoggedObject& another) const
	{
		return Comparator < another.Comparator;
	}
};

class FoggedSmudge : public FoggedObject
{
public:
	int Smudge;
	unsigned char SmudgeData;

public:
	FoggedSmudge(CoordStruct& location, RectangleStruct& bound, int smudge);
	FoggedSmudge(CellClass* pCell, int smudge, unsigned char smudgeData);
	// FoggedSmudge(ObjectClass* pObject, int smudge);

	virtual ~FoggedSmudge() override;
	virtual void Draw(RectangleStruct& rect) override;
	virtual int GetType() override;
	virtual BuildingTypeClass* GetBuildingType() override;
	virtual bool Load(PhobosStreamReader& Stm, bool RegisterForChange) override;
	virtual bool Save(PhobosStreamWriter& Stm) const override;
};

class FoggedTerrain : public FoggedObject
{
public:
	int Terrain;

public:
	FoggedTerrain(CoordStruct& location, RectangleStruct& bound, int terrain);
	FoggedTerrain(ObjectClass* pObject, int terrain);

	virtual ~FoggedTerrain() override;
	virtual void Draw(RectangleStruct& rect) override;
	virtual int GetType() override;
	virtual BuildingTypeClass* GetBuildingType() override;
	virtual bool Load(PhobosStreamReader& Stm, bool RegisterForChange) override;
	virtual bool Save(PhobosStreamWriter& Stm) const override;
};

class FoggedOverlay : public FoggedObject
{
public:
	int Overlay;
	unsigned char OverlayData;

public:
	FoggedOverlay(CoordStruct& location, RectangleStruct& bound, int overlay, unsigned char overlayData);
	FoggedOverlay(CellClass* pCell, int overlay, unsigned char overlayData);
	// FoggedOverlay(ObjectClass* pObject, int overlay, unsigned char overlayData);

	virtual ~FoggedOverlay() override;
	virtual void Draw(RectangleStruct& rect) override;
	virtual int GetType() override;
	virtual BuildingTypeClass* GetBuildingType() override;
	virtual bool Load(PhobosStreamReader& Stm, bool RegisterForChange) override;
	virtual bool Save(PhobosStreamWriter& Stm) const override;
};

class FoggedBuilding : public FoggedObject
{
public:
	HouseClass* Owner;
	BuildingTypeClass* Type;
	int FrameIndex;
	bool FireStormWall;

public:
	FoggedBuilding(CoordStruct& location, RectangleStruct& bound, BuildingClass* building, bool bTranslucent);
	FoggedBuilding(BuildingClass* pObject, bool bTranslucent);

	virtual ~FoggedBuilding() override;
	virtual void Draw(RectangleStruct& rect) override;
	virtual int GetType() override;
	virtual BuildingTypeClass* GetBuildingType() override;
	virtual bool Load(PhobosStreamReader& Stm, bool RegisterForChange) override;
	virtual bool Save(PhobosStreamWriter& Stm) const override;
};