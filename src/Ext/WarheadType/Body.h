#pragma once

#include <CCINIClass.h>
#include <WarheadTypeClass.h>

#include "../_Container.hpp"
#include "../../Phobos.h"

#include "../../Utilities/Debug.h"

class WarheadTypeExt
{
public:
	using base_type = WarheadTypeClass;

	class ExtData final : public Extension<WarheadTypeClass>
	{
	public:

		bool SpySat;
		bool BigGap;
		int TransactMoney;
		char SplashList_Buffer[0x400];
		DynamicVectorClass<AnimTypeClass*> SplashList;

		ExtData(WarheadTypeClass* OwnerObject) : Extension<WarheadTypeClass>(OwnerObject),
			SpySat(false),
			BigGap(false),
			TransactMoney(0),
			SplashList()
		{ }

		virtual void LoadFromINIFile(CCINIClass* pINI) override;
		virtual ~ExtData() = default;

		virtual void InvalidatePointer(void* ptr, bool bRemoved) override {}

		virtual void LoadFromStream(IStream* Stm);

		virtual void SaveToStream(IStream* Stm);
	};

	class ExtContainer final : public Container<WarheadTypeExt> {
	public:
		ExtContainer();
		~ExtContainer();
	};

	static ExtContainer ExtMap;
};
