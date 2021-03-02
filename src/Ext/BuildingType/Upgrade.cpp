#include <Helpers/Macro.h>
#include <BuildingClass.h>
#include <BuildingTypeClass.h>
#include <HouseClass.h>
#include "../../Utilities/EnumFunctions.h"
#include "Body.h"

bool CanUpgrade(BuildingClass* building, BuildingTypeClass* upgrade, HouseClass* upgradeOwner) {
	auto extUpgrade = BuildingTypeExt::ExtMap.Find(upgrade);
	if (EnumFunctions::CanTargetHouse(extUpgrade->PowersUp_Owner, upgradeOwner, building->Owner)) {
		// PowersUpBuilding
		if (_stricmp(building->Type->ID, upgrade->PowersUpBuilding) == 0)
			return true;

		// PowersUp.Buildings
		for (auto& powerup_idx : extUpgrade->PowersUp_Buildings)
		{
			if (_stricmp(building->Type->ID, BuildingTypeClass::Array->GetItem(powerup_idx)->ID) == 0)
				return true;
		}
	}
	return false;
}

// =============================
// container hooks

DEFINE_HOOK(452678, CanUpgrade_UpgradeBuildings, 8)
{
	GET(BuildingClass*, pBuilding, ECX);
	GET_STACK(BuildingTypeClass*, pUpgrade, 0x0C);
	GET(HouseClass*, upgradeOwner, EAX);

	if (CanUpgrade(pBuilding, pUpgrade, upgradeOwner)) {
		R->EAX(pBuilding->Type->PowersUpToLevel);
		return 0x4526A7;  // continue
	}

	return 0x4526B5;  // fail
}

DEFINE_HOOK(4408EB, Unlimbo_UpgradeBuildings, A)
{
	GET(BuildingClass*, buildingUnderMouse, EDI);
	GET(BuildingClass*, pUpgrade, ESI);

	if (CanUpgrade(buildingUnderMouse, pUpgrade->Type, pUpgrade->Owner)) {
		R->EBX(pUpgrade->Type);
		pUpgrade->Owner = buildingUnderMouse->Owner;
		return 0x440912; // continue
	}

	return 0x440926; // fail
}
