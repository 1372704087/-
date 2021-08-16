#include "FogOfWar.h"

#include "FoggedObject.h"

#include <ScenarioClass.h>

#include <Ext/Cell/Body.h>
#include <Misc/MapRevealer.h>

// issue #28 : Fix vanilla YR Fog of War bugs & issues
// Reimplement it would be nicer.

std::set<FoggedObject*> FogOfWar::FoggedObjects;

void FogOfWar::Reveal_DisplayClass_All_To_Look_Ground(TechnoClass* pTechno, DWORD dwUnk, DWORD dwUnk2)
{
#define _LOOK_ \
	{ \
		pTechno->See(0, dwUnk2); \
		if (pTechno->IsInAir()) \
			MapClass::Instance->RevealArea3(&pTechno->Location, \
				pTechno->LastSightRange - 3, pTechno->LastSightRange + 3, false); \
		return; \
	}

	if (!dwUnk || pTechno->WhatAmI() != AbstractType::Building)
	{
		if (pTechno->GetTechnoType()->RevealToAll)
			_LOOK_;
		if (pTechno->DiscoveredByPlayer)
		{
			if (SessionClass::Instance->GameMode != GameMode::Campaign && pTechno->Owner == HouseClass::Player())
				_LOOK_;
			if (pTechno->Owner->CurrentPlayer || pTechno->Owner->PlayerControl)
				_LOOK_;
		}
		auto const pHouse = pTechno->Owner;
		auto const pPlayer = HouseClass::Player();
		if (pPlayer)
		{
			if (pPlayer == pHouse)
				_LOOK_;
			if (pPlayer->ArrayIndex == pHouse->ArrayIndex || pPlayer->ArrayIndex != -1 && pHouse->IsAlliedWith(pPlayer))
				_LOOK_;
		}
	}

#undef _LOOK_
}

bool FogOfWar::MapClass_RevealFogShroud(CellStruct* pMapCoords, HouseClass* pHouse)
{
	auto pCell = MapClass::Instance->GetCellAt(*pMapCoords);
	bool bUnk = pCell->Flags & 2;
	bool bUnk2 = !bUnk || (pCell->CopyFlags & 8) == 0;
	bool bRevealCheckParam = bUnk2;

	pCell->Flags = pCell->Flags & 0xFFFFFFBF | 2;
	pCell->CopyFlags = pCell->CopyFlags & 0xFFFFFFBF | 8;

	char Occlusion = TacticalClass::Instance->GetOcclusion(*pMapCoords, false);
	char Visibility = pCell->Visibility;
	if (Visibility != Occlusion)
	{
		Visibility = Occlusion;
		bUnk2 = true;
		pCell->Visibility = Occlusion;
	}
	if (Visibility == -1)
		pCell->CopyFlags |= 0x10;

	char FoggedOcclusion = TacticalClass::Instance->GetOcclusion(*pMapCoords, true);
	char Foggedness = pCell->Foggedness;
	if (Foggedness != FoggedOcclusion)
	{
		Foggedness = FoggedOcclusion;
		bUnk2 = true;
		pCell->Foggedness = FoggedOcclusion;
	}
	if (Foggedness == -1)
		pCell->Flags |= 0x1;

	if (bUnk2)
	{
		TacticalClass::Instance->RegisterCellAsVisible(pCell);
		MapClass::Instance->RevealCheck(pCell, pHouse, bRevealCheckParam);
	}

	if (!bUnk && ScenarioClass::Instance->SpecialFlags.FogOfWar)
		pCell->CleanFog();

	return bUnk2;
}

bool FogOfWar::IsLocationFogged(CoordStruct* pCoord)
{
	MapRevealer revealer(*pCoord);
	auto pCell = MapClass::Instance->GetCellAt(revealer.Base());
	if (pCell->Flags & 2)
		return false;
	return ((pCell->GetNeighbourCell(3u)->Flags & 2) == 0);
}

void FogOfWar::ClearFoggedObjects(CellClass* pCell)
{
	auto const pExt = CellExt::ExtMap.Find(pCell);

	if (pExt->FoggedObjects.size())
	{
		for (auto pFoggedObject : pExt->FoggedObjects)
			if (pFoggedObject)
			{
				if (pFoggedObject->CoveredRTTIType == AbstractType::Building)
				{
					auto pRealCell = MapClass::Instance->GetCellAt(pFoggedObject->Location);
					if (pRealCell != pCell)
						if (auto const pRealExt = CellExt::ExtMap.Find(pRealCell))
							if (pRealExt->FoggedObjects.size())
							{
								auto itr = std::find(pRealExt->FoggedObjects.begin(), 
									pRealExt->FoggedObjects.end(), pFoggedObject);

								pRealExt->FoggedObjects.erase(itr);
							}
				}
				GameDelete(pFoggedObject);
			}

		pExt->FoggedObjects.clear();
	}
}

bool FogOfWar::DrawIfVisible(FoggedObject* pFoggedObject, RectangleStruct* pRect)
{
	if (!pFoggedObject->Visible)
		return false;

	auto rect = pFoggedObject->Bound;
	rect.X += DSurface::ViewBounds->X - TacticalClass::Instance->TacticalPos.X;
	rect.Y += DSurface::ViewBounds->Y - TacticalClass::Instance->TacticalPos.Y;

	RectangleStruct ret = Drawing::Intersect(*pRect, rect);
	if (ret.Width <= 0 || ret.Height <= 0)
		return false;

	pFoggedObject->Draw(*pRect);

	return true;
}

bool FogOfWar::DrawBldIfVisible(FoggedBuilding* pFoggedBuilding, RectangleStruct* pRect)
{
	if (!pFoggedBuilding->Visible)
		return false;

	if (!pFoggedBuilding->BuildingAnims.size())
		return FogOfWar::DrawIfVisible(pFoggedBuilding, pRect);

	bool bDrawAllSubAnims = false;
	for (auto& Anim : pFoggedBuilding->BuildingAnims)
	{
		RectangleStruct vRect = *pRect;

		auto rect = Anim.Bound;
		rect.X += DSurface::ViewBounds->X - TacticalClass::Instance->TacticalPos.X;
		rect.Y += DSurface::ViewBounds->Y - TacticalClass::Instance->TacticalPos.Y;

		RectangleStruct ret = Drawing::Intersect(vRect, rect);
		if (ret.Width <= 0 || ret.Height <= 0)
			continue;

		bDrawAllSubAnims = true;
		break;
	}

	if (bDrawAllSubAnims)
	{
		pFoggedBuilding->Draw(*pRect);
		for (auto& Anim : pFoggedBuilding->BuildingAnims)
		{
			if (!Anim.Visible) continue;
			RectangleStruct vRect = *pRect;
			pFoggedBuilding->DrawBuildingAnim(Anim, vRect);
		}
		return true;
	}
	else
		return FogOfWar::DrawIfVisible(pFoggedBuilding, pRect);
}

void FogOfWar::UnionRectangle(RectangleStruct* rect1, RectangleStruct* rect2)
{
    RectangleStruct rect;
    rect.X = std::min(rect1->X, rect2->X);
    rect.Y = std::min(rect1->Y, rect2->Y);
    rect.Width = std::max(rect1->X + rect1->Width, rect2->X + rect2->Width) - rect.X;
    rect.Height = std::max(rect1->Y + rect1->Height, rect2->Y + rect2->Height) - rect.Y;
    *rect1 = rect;
}

void __fastcall FogOfWar::MapClass_Reveal0(MapClass* pThis, void* _, CoordStruct* pCoord, int Radius,
		HouseClass* pHouse, bool OnlyOutline, bool a6, bool SkipReveal, bool AllowRevealByHeight, bool Add)
{
	MapRevealer const revealer(*pCoord);
	revealer.Reveal0(*pCoord, Radius, pHouse, OnlyOutline, a6, SkipReveal, AllowRevealByHeight, Add);
	revealer.UpdateShroud(0, static_cast<size_t>(std::max(Radius, 0)), false);
}

void __fastcall FogOfWar::MapClass_Reveal2(MapClass* pThis, void*_, CoordStruct* Coords, int Height, int Radius, int SkipReveal)
{
	MapRevealer revealer(*Coords);
	revealer.UpdateShroud(static_cast<size_t>(std::max(Height, 0)), static_cast<size_t>(std::max(Radius, 0)), SkipReveal);
}
