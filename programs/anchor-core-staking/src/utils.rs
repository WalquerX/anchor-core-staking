use anchor_lang::prelude::*;
use mpl_core::{
    accounts::BaseCollectionV1,
    fetch_plugin,
    instructions::{AddCollectionPluginV1CpiBuilder, UpdateCollectionPluginV1CpiBuilder},
    types::{Attribute, Attributes, Plugin, PluginAuthority, PluginType},
};
use crate::error::ErrorCode;

/// Adds 1 (increment = true) or subtracts 1 (increment = false)
/// from the "total_staked" attribute on the collection.
/// On the first stake, the collection has no Attributes plugin yet, so we add it.
pub fn update_total_staked<'info>(
    mpl_core_program: &AccountInfo<'info>,
    collection: &AccountInfo<'info>,
    update_authority: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    update_authority_seeds: &[&[u8]],
    increment: bool,
) -> Result<()> {
    // 1. Read the collection attributes (if they exist)
    let attributes_fetched: Option<Attributes> =
        fetch_plugin::<BaseCollectionV1, Attributes>(collection, PluginType::Attributes)
            .ok()
            .map(|(_, attrs, _)| attrs);

    // 2. Keep all other attributes. Read the current counter (0 if not there).
    let mut current: u64 = 0;
    let mut attributes_list: Vec<Attribute> = Vec::new();

    if let Some(attributes) = &attributes_fetched {
        for attribute in &attributes.attribute_list {
            if attribute.key == "total_staked" {
                current = attribute.value.parse::<u64>().map_err(|_| ErrorCode::InvalidTotalStaked)?;
            } else {
                attributes_list.push(attribute.clone());
            }
        }
    }

    // 3. New value. Underflow (unstake when the counter is 0) is an error.
    let new_total = if increment {
        current.checked_add(1)
    } else {
        current.checked_sub(1)
    }
    .ok_or(ErrorCode::InvalidTotalStaked)?;

    attributes_list.push(Attribute {
        key: "total_staked".to_string(),
        value: new_total.to_string(),
    });
    let plugin = Plugin::Attributes(Attributes { attribute_list: attributes_list });

    // 4. Add or update the collection plugin.
    //    Attributes is Authority-Managed: the update authority PDA signs.
    if attributes_fetched.is_none() {
        AddCollectionPluginV1CpiBuilder::new(mpl_core_program)
            .collection(collection)
            .payer(payer)
            .authority(Some(update_authority))
            .system_program(system_program)
            .plugin(plugin)
            .init_authority(PluginAuthority::UpdateAuthority)
            .invoke_signed(&[update_authority_seeds])?;
    } else {
        UpdateCollectionPluginV1CpiBuilder::new(mpl_core_program)
            .collection(collection)
            .payer(payer)
            .authority(Some(update_authority))
            .system_program(system_program)
            .plugin(plugin)
            .invoke_signed(&[update_authority_seeds])?;
    }

    Ok(())
}